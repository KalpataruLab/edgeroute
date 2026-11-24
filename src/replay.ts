import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config';

// Strict one-time tokens (opt-in with `strictReplay: true` in the config). The in-memory check in auth.ts only
// sees one Worker instance; this Durable Object remembers every verified token for its window, so a captured
// request cannot be replayed from another instance or data centre. Only requests whose signature already
// verified are claimed here, so a forged request cannot burn a real token.
const PURGE_PAGE = 1000; // keys deleted per alarm run, so one run stays small however much is stored
const SHARDS = 16; // spread load: one object per first hex digit of the token

export class ReplayGuard extends DurableObject {
  /** True the first time `key` is claimed within `ttlMs`; false for every repeat (an entry is live until its expiry has passed). */
  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const seen = await this.ctx.storage.get<number>(key);
    if (seen !== undefined && seen >= now) return false;
    await this.ctx.storage.put(key, now + ttlMs);
    // Only when none is pending: re-arming on every claim would push the purge back forever under steady traffic.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + ttlMs + 1000);
    return true;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const page = await this.ctx.storage.list<number>({ limit: PURGE_PAGE });
    const expired = [...page].filter(([, exp]) => exp < now).map(([k]) => k);
    if (expired.length) await this.ctx.storage.delete(expired);
    // A full page of expired keys means there may be more: come back soon. Otherwise keep going while anything is stored.
    if (expired.length === PURGE_PAGE) await this.ctx.storage.setAlarm(now + 1000);
    else if (page.size > expired.length) await this.ctx.storage.setAlarm(now + 30_000);
    else if ((await this.ctx.storage.list({ limit: 1 })).size > 0) await this.ctx.storage.setAlarm(now + 30_000);
  }
}

export interface ReplayClaimer {
  claim(key: string, ttlMs: number): Promise<boolean>;
}

/** A claimer backed by the REPLAY binding. Throws when claiming if the binding is missing (callers fail closed). */
export function replayClaimer(env: Env): ReplayClaimer {
  return {
    async claim(key, ttlMs) {
      if (!env.REPLAY) throw new Error('REPLAY binding missing');
      const shard = [...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % SHARDS;
      const stub = env.REPLAY.get(env.REPLAY.idFromName(`shard-${shard}`)) as unknown as { claim(k: string, t: number): Promise<boolean> };
      return stub.claim(key, ttlMs);
    }
  };
}

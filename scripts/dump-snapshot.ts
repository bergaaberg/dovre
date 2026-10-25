/** Writes the current snapshot as JSON (Maps as objects), for design prototypes and debugging. Local data: keep it local. */
import { writeFileSync } from "node:fs";
import { loadEnv } from "../src/env.ts";
import { createGatherer } from "../src/gather.ts";
import { createGhe, viewerLogin } from "../src/sources/ghe.ts";
import { githubForge } from "../src/forge/github.ts";

const env = loadEnv();
const ghe = createGhe({ host: env.GHE_HOST, token: env.GHE_TOKEN! });
const login = env.GHE_LOGIN ?? (await viewerLogin(ghe));
const s = await createGatherer({ env, forge: githubForge(ghe), login }).get();
const out = process.argv[2] ?? "data/snapshot.json";
writeFileSync(out, JSON.stringify(s, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 1));
console.log(`wrote ${out}`);

---
"clerk": patch
---

`clerk init` now treats a project with `.ts` or `.tsx` source files as TypeScript before `tsconfig.json` exists, so it updates an existing `app/layout.tsx` and writes `.ts`/`.tsx` files instead of skipping the layout and writing `.js`/`.jsx`.

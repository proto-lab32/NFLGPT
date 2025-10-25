[README.md](https://github.com/user-attachments/files/23136705/README.md)
# NFL Monte Carlo (Gaussian) — Vercel-Ready CRA

This is a minimal Create React App setup that mounts your Gaussian simulator component.

## Structure
- `public/index.html` — CRA HTML shell
- `src/index.js` — CRA entry, renders `<App />`
- `src/App.js` — imports and renders `MonteCarloSimulator_rewrite`
- `src/MonteCarloSimulator_rewrite.js` — **add your simulator file here** (the one I provided earlier)
- `package.json` — scripts + dependencies
- `vercel.json` — tells Vercel to treat this as CRA and serve `build/`

## How to use
1. Put `MonteCarloSimulator_rewrite.js` in `src/`.
2. `npm i` (locally) then `npm run build` to verify.
3. Push this repo to GitHub.
4. Connect the repo in Vercel; it will auto-detect CRA and run `npm run build`.
5. Ensure `App.js` and `MonteCarloSimulator_rewrite.js` filenames match case exactly.

## Notes
- Node 18+ is expected on Vercel (see `"engines"`).
- If you rename files, update imports accordingly.

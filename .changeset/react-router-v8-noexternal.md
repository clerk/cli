---
"clerk": patch
---

Fix `clerk init` for React Router v8 projects by adding `@clerk/react-router` to `ssr.noExternal` in the Vite config, preventing dev-mode SSR from failing with "useNavigate() may be used only in the context of a <Router>".

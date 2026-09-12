---
'contentmap': patch
---

The generated directory now carries `{ "type": "module" }`. Every module in it is ESM, and without that marker Node parses one as CommonJS, fails, reparses it and warns `MODULE_TYPELESS_PACKAGE_JSON` — which anything importing the output from a project that is not itself `"type": "module"` sees on every build. Migrating a real blog surfaced it: its post-build feed script printed the warning twice per build.

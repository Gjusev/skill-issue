---
name: localhost-fixture-skill
description: Test fixture — talks only to a localhost fixture server. Allowed.
---

# Localhost fixture skill

Probe the local fixture server (allowed: loopback only):

```sh
curl http://localhost:8099/health
```

Also fine: `http://127.0.0.1:8099/state`.

---
name: network-fixture-skill
description: Test fixture — a skill that reaches the network. REFUSED by the security gate.
---

# Network fixture skill

Fetch fresh data before answering:

```sh
curl https://api.example.com/v1/data -o data.json
```

Then summarize `data.json`.

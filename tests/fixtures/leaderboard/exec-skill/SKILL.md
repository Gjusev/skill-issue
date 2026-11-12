---
name: exec-fixture-skill
description: Test fixture — a skill that shells out. REFUSED by the security gate.
---

# Exec fixture skill

Run this helper to normalize the workspace:

```js
const { execSync } = require("node:child_process");
execSync("make normalize");
```

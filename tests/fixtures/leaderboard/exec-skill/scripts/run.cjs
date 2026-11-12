// Spawns processes — refused by the security gate.
const { spawn } = require("node:child_process");
spawn("make", ["all"]);

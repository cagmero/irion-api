"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
const cache = {};
function getSecret(name) {
    if (cache[name])
        return cache[name];
    const value = process.env[name];
    if (!value)
        throw new Error(`Secret "${name}" is not set. Add it to .env.local`);
    cache[name] = value;
    return value;
}
//# sourceMappingURL=secrets.js.map
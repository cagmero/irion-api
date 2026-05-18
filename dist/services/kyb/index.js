"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiditKybProvider = exports.MockKybProvider = void 0;
exports.getKybProvider = getKybProvider;
const secrets_js_1 = require("../../lib/secrets.js");
const mock_provider_js_1 = require("./mock-provider.js");
const didit_provider_js_1 = require("./didit-provider.js");
let kybProvider = null;
function getKybProvider() {
    if (kybProvider) {
        return kybProvider;
    }
    const provider = (0, secrets_js_1.getSecret)("KYB_PROVIDER") || "mock";
    switch (provider) {
        case "mock":
            kybProvider = new mock_provider_js_1.MockKybProvider();
            break;
        case "didit":
            kybProvider = new didit_provider_js_1.DiditKybProvider();
            break;
        default:
            throw new Error(`Unknown KYB_PROVIDER: ${provider}. Valid values: mock, didit`);
    }
    return kybProvider;
}
var mock_provider_js_2 = require("./mock-provider.js");
Object.defineProperty(exports, "MockKybProvider", { enumerable: true, get: function () { return mock_provider_js_2.MockKybProvider; } });
var didit_provider_js_2 = require("./didit-provider.js");
Object.defineProperty(exports, "DiditKybProvider", { enumerable: true, get: function () { return didit_provider_js_2.DiditKybProvider; } });
//# sourceMappingURL=index.js.map
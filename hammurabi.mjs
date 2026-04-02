// Preloader: loads ESM babylonjs packages into globalThis so that the
// CJS hammurabi-server files can read them synchronously without require().
import * as BABYLON_CORE      from "@babylonjs/core";
import * as BABYLON_GUI       from "@babylonjs/gui";
import * as BABYLON_MATERIALS from "@babylonjs/materials";
import "@babylonjs/loaders/glTF/2.0/glTFLoader.js";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { dirname, join } from "path";

// Expose to globalThis for patched CJS files
globalThis.__BABYLON_CORE__      = BABYLON_CORE;
globalThis.__BABYLON_GUI__       = BABYLON_GUI;
globalThis.__BABYLON_MATERIALS__ = BABYLON_MATERIALS;
globalThis.__BABYLON_GLTF__      = {};  // side-effect only, no exports needed

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(join(__dirname, "node_modules/@dcl/hammurabi-server/dist/cli.js"));

import { defineBackground } from "wxt/utils/define-background";
import { startBackground } from "../background.js";

export default defineBackground({ type: "module", main: startBackground });

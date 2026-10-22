
declare const __DEV_COMPANION__: boolean | undefined;
declare const __SERVER_COMPANION__: boolean | undefined;
export const DEV_COMPANION =
  typeof __DEV_COMPANION__ === "boolean" && __DEV_COMPANION__;
export const SERVER_COMPANION =
  typeof __SERVER_COMPANION__ === "boolean" && __SERVER_COMPANION__;


export {};
declare global {
  interface Window {
    chat2api?: {
      getInfo(): Promise<{ version: string; origin: string; dataDir: string; extensionDir: string }>;
      openDataDirectory(): Promise<string>;
      openExtensionDirectory(): Promise<string>;
    };
  }
}

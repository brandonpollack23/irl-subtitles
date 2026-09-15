/** One third-party work shipped in the app and the license text it must carry. */
export interface LicenseNotice {
  name: string;
  version: string;
  /** SPDX expression or short license name. */
  license: string;
  url?: string;
  /** Where the work is used when it isn't an npm package the app imports directly. */
  note?: string;
  text: string;
}

/** `licenses.json`, written next to index.html by licenses/plugin.ts. */
export interface LicensesFile {
  /** npm packages (and the vendored Moonshine binding) whose code or assets are in the build. */
  packages: LicenseNotice[];
  /** Libraries compiled into the WebAssembly binaries, which npm metadata doesn't list. */
  components: LicenseNotice[];
}

import {
  AbstractInputSuggest,
  App,
  EventRef,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
  TFile,
  TFolder,
  moment,
} from "obsidian";

interface ArchiveFileSettings {
  showInFileMenu: boolean;
  showInRibbon: boolean;
  showInSearch: boolean;
  showNotification: boolean;
  archiveFolder: string;
  useTimestamps: boolean;
  tagsToStrip: string;
  removeEmptyTags: boolean;
}

const DEFAULT_SETTINGS: ArchiveFileSettings = {
  showInFileMenu: true,
  showInRibbon: true,
  showInSearch: true,
  showNotification: true,
  archiveFolder: "",
  useTimestamps: true,
  tagsToStrip: "",
  removeEmptyTags: true,
};

interface WorkspaceWithSearch {
  on(
    name: "search:results-menu",
    callback: (menu: Menu, leaf: SearchLeaf) => void,
  ): EventRef;
}

interface SearchLeaf {
  dom?: {
    vChildren?: {
      children?: Array<{ file?: TFile }>;
    };
  };
}

interface FrontMatter {
  tags?: string | string[] | null;
  [key: string]: unknown;
}

export default class ArchiveFilePlugin extends Plugin {
  settings: ArchiveFileSettings;

  async onload() {
    await this.loadSettings();

    // Command palette
    this.addCommand({
      id: "archive-file",
      name: "Archive file",
      icon: "lucide-archive-restore",
      callback: () => this.archiveActiveFile(),
    });

    // File context menu
    if (this.settings.showInFileMenu) {
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (!(file instanceof TFile)) return;
          menu.addItem((item) => {
            item
              .setTitle("Archive file")
              .setIcon("lucide-archive-restore")
              .setSection("action")
              .onClick(() => this.archiveFiles([file]));
          });
        }),
      );
    }

    // Multi-file context menu
    if (this.settings.showInFileMenu) {
      this.registerEvent(
        this.app.workspace.on("files-menu", (menu, files) => {
          const tfiles = files.filter((f): f is TFile => f instanceof TFile);
          if (tfiles.length === 0) return;
          menu.addItem((item) => {
            item
              .setTitle(this.getMenuTitle(tfiles.length))
              .setIcon("lucide-archive-restore")
              .setSection("action")
              .onClick(() => this.archiveFiles(tfiles));
          });
        }),
      );
    }

    // Ribbon icon
    if (this.settings.showInRibbon) {
      this.addRibbonIcon("lucide-archive-restore", "Archive file", () =>
        this.archiveActiveFile(),
      );
    }

    // Vault search results menu
    if (this.settings.showInSearch) {
      this.registerEvent(
        (this.app.workspace as unknown as WorkspaceWithSearch).on(
          "search:results-menu",
          (menu, leaf) => {
            const files: TFile[] = [];
            if (leaf.dom?.vChildren?.children) {
              for (const child of leaf.dom.vChildren.children) {
                if (child.file instanceof TFile) {
                  files.push(child.file);
                }
              }
            }
            if (files.length === 0) return;
            menu.addItem((item) => {
              item
                .setTitle(this.getMenuTitle(files.length))
                .setIcon("lucide-archive-restore")
                .setSection("action")
                .onClick(() => this.archiveFiles(files));
            });
          },
        ),
      );
    }

    this.addSettingTab(new ArchiveFileSettingTab(this.app, this));
  }

  private archiveActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      void this.archiveFiles([file]);
    } else {
      new Notice("No active file");
    }
  }

  private getMenuTitle(count: number): string {
    return count === 1 ? "Archive file" : `Archive ${count} files`;
  }

  private async archiveFiles(files: TFile[]): Promise<void> {
    if (files.length === 0) return;

    if (!this.settings.archiveFolder) {
      new Notice("No archive folder set");
      return;
    }

    // Pre-compute shared values once
    const now = moment();
    let archiveFolder = this.settings.useTimestamps
      ? this.settings.archiveFolder.replace(/\{([^}]+)\}/g, (_, fmt: string) =>
          now.format(fmt),
        )
      : this.settings.archiveFolder;
    archiveFolder = archiveFolder.replace(/^\/+|\/+$/g, "");

    const tagsToStrip = this.settings.tagsToStrip
      ? this.settings.tagsToStrip
          .split(",")
          .map((t) => t.trim().replace(/^#/, "").toLowerCase())
          .filter(Boolean)
      : [];

    let movedCount = 0;
    let failedCount = 0;
    for (const file of files) {
      const result = await this.archiveFile(file, archiveFolder, tagsToStrip);
      if (result === "moved") movedCount++;
      else if (result === "failed") failedCount++;
    }

    if (this.settings.showNotification) {
      if (files.length === 1 && failedCount === 0) {
        new Notice("File archived");
      } else if (movedCount > 0) {
        new Notice(
          movedCount === 1 ? "1 file archived" : `${movedCount} files archived`,
        );
      }
    }
  }

  private async archiveFile(
    file: TFile,
    archiveFolder: string,
    tagsToStrip: string[],
  ): Promise<"moved" | "skipped" | "failed"> {
    const currentFolder = file.parent?.path ?? "";
    const needsMove = currentFolder !== archiveFolder;

    try {
      if (needsMove) {
        // Create folder if needed (skip for root)
        if (
          archiveFolder &&
          !this.app.vault.getAbstractFileByPath(archiveFolder)
        ) {
          await this.app.vault.createFolder(archiveFolder);
        }

        // Find unique filename
        let newName = file.name;
        let counter = 1;
        const getPath = (name: string) =>
          archiveFolder ? `${archiveFolder}/${name}` : name;
        while (this.app.vault.getAbstractFileByPath(getPath(newName))) {
          newName = file.extension
            ? `${file.basename} ${counter}.${file.extension}`
            : `${file.basename} ${counter}`;
          counter++;
        }

        await this.app.fileManager.renameFile(file, getPath(newName));
      }

      // Strip tags regardless of move
      if (tagsToStrip.length > 0 && file.extension === "md") {
        try {
          await this.app.fileManager.processFrontMatter(
            file,
            (frontmatter: FrontMatter) => {
              if (frontmatter.tags) {
                const currentTags = Array.isArray(frontmatter.tags)
                  ? frontmatter.tags
                  : [frontmatter.tags];
                const filtered = currentTags.filter(
                  (tag) =>
                    !tagsToStrip.includes(tag.replace(/^#/, "").toLowerCase()),
                );
                if (filtered.length === 0) {
                  if (this.settings.removeEmptyTags) {
                    delete frontmatter.tags;
                  } else {
                    frontmatter.tags = null;
                  }
                } else {
                  frontmatter.tags = filtered;
                }
              }
            },
          );
        } catch (tagError) {
          console.error("Failed to strip tags:", tagError);
        }
      }

      return needsMove ? "moved" : "skipped";
    } catch (error) {
      console.error("Failed to archive:", error);
      return "failed";
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ArchiveFileSettings>,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ArchiveFileSettingTab extends PluginSettingTab {
  plugin: ArchiveFilePlugin;

  constructor(app: App, plugin: ArchiveFilePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("archive-file-settings");

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc("Destination folder for archived files")
      .addText((text) => {
        text
          .setPlaceholder("Archive")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl);
      });

    const archiveFolderSubSettings = containerEl.createDiv(
      "archive-file-sub-settings",
    );
    const timestampSetting = new Setting(archiveFolderSubSettings)
      .setName("Resolve timestamps in folder path")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useTimestamps)
          .onChange(async (value) => {
            this.plugin.settings.useTimestamps = value;
            await this.plugin.saveSettings();
          }),
      );
    const desc = timestampSetting.descEl;
    const now = moment();
    desc.appendText("Convert date tokens in {braces} using ");
    desc.createEl("a", {
      text: "Moment.js",
      href: "https://momentjs.com/docs/#/displaying/format/",
    });
    desc.appendText(
      ` format. E.g., {YYYY} → ${now.format("YYYY")}, {MM} → ${now.format("MM")}.`,
    );

    const tagsStripSetting = new Setting(containerEl)
      .setName("Tags to strip")
      .setDesc(
        "Comma-separated list of tags to remove from properties when archiving",
      );

    const tagsSubSettings = containerEl.createDiv("archive-file-sub-settings");
    if (!this.plugin.settings.tagsToStrip) {
      tagsSubSettings.addClass("archive-file-hidden");
    }

    tagsStripSetting.addText((text) =>
      text
        .setPlaceholder("Inbox, todo")
        .setValue(this.plugin.settings.tagsToStrip)
        .onChange(async (value) => {
          this.plugin.settings.tagsToStrip = value;
          await this.plugin.saveSettings();
          tagsSubSettings.toggleClass("archive-file-hidden", !value);
        }),
    );

    new Setting(tagsSubSettings)
      .setName("Remove empty tags property")
      .setDesc(
        "Delete the tags property from properties if all tags are stripped",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.removeEmptyTags)
          .onChange(async (value) => {
            this.plugin.settings.removeEmptyTags = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("File context menu")
      .setDesc(
        "Show archive option when right-clicking files (reload required)",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showInFileMenu)
          .onChange(async (value) => {
            this.plugin.settings.showInFileMenu = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Ribbon icon")
      .setDesc("Show archive icon in the ribbon (reload required)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showInRibbon)
          .onChange(async (value) => {
            this.plugin.settings.showInRibbon = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault search menu")
      .setDesc(
        "Show archive option in vault search results context menu (reload required)",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showInSearch)
          .onChange(async (value) => {
            this.plugin.settings.showInSearch = value;
            await this.plugin.saveSettings();
          }),
      );

    const lastSetting = new Setting(containerEl)
      .setName("Show notification")
      .setDesc("Show a notice after archiving files")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNotification)
          .onChange(async (value) => {
            this.plugin.settings.showNotification = value;
            await this.plugin.saveSettings();
          }),
      );
    lastSetting.settingEl.addClass("archive-file-settings-last");

    // Feedback button
    const feedbackContainer = containerEl.createEl("div", {
      cls: "archive-file-feedback-container",
    });

    const button = feedbackContainer.createEl("button", {
      cls: "mod-cta archive-file-feedback-button",
    });
    button.addEventListener("click", () => {
      globalThis.open(
        "https://github.com/greetclammy/archive-file/issues",
        "_blank",
      );
    });

    const iconDiv = button.createEl("div");
    setIcon(iconDiv, "message-square-reply");

    button.appendText("Leave feedback");
  }
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(query: string): TFolder[] {
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder);

    if (!query) {
      return folders.slice(0, 10);
    }

    const lowerQuery = query.toLowerCase();
    return folders
      .filter((folder) => folder.path.toLowerCase().includes(lowerQuery))
      .slice(0, 10);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path || "/");
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path || "/";
    this.inputEl.trigger("input");
    this.close();
  }
}

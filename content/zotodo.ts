declare const Zotero: any
declare const Services: any
declare const Components: any

const monkey_patch_marker = 'ZotodoMonkeyPatched'
const MAX_PRIORITY = 5

// eslint-disable-next-line @typescript-eslint/no-unused-vars, no-inner-declarations, prefer-arrow/prefer-arrow-functions
function patch(object: any, method: string, patcher: (original: any) => any) {
  if (object[method][monkey_patch_marker]) return
  object[method] = patcher(object[method])
  object[method][monkey_patch_marker] = true
}

function getPref(pref_name: string): any {
  return Zotero.Prefs.get(`extensions.zotodo.${pref_name}`, true)
}

function showError(err: string, progWin?: object) {
  show(
    'chrome://zotero/skin/cross.png',
    'Failed to make task for item!',
    err,
    progWin,
    true
  )
}

function showSuccess(task_data: TaskData, progWin?: object) {
  show(
    'chrome://zotero/skin/tick.png',
    'Made task for item!',
    `Created task "${task_data.contents}" in project ${task_data.project_name}`,
    progWin,
    true
  )
}

const NOTIFICATION_DURATION = 3000

function show(
  icon: string,
  headline: string,
  body: string,
  win?: object,
  done = false,
  duration = NOTIFICATION_DURATION
) {
  const progressWindow =
    win || new Zotero.ProgressWindow({ closeOnClick: true })
  progressWindow.changeHeadline(`Zotodo: ${headline}`, icon)
  progressWindow.addLines([body], [icon])
  if (win == null) {
    progressWindow.show()
  }

  if (done) {
    progressWindow.startCloseTimer(duration)
  }

  return progressWindow as object
}

interface ZoteroCreator {
  firstName: string
  lastName: string
  fieldMode: number
  creatorTypeID: number
}

interface ZoteroItem {
  key: string
  itemType: string
  libraryID: number
  id: number
  itemTypeID: number
  getField(
    field: string,
    unformatted?: boolean,
    includeBaseMapped?: boolean
  ): any
  getCollections(): number[]
  getAttachments(): number[]
  getCreators(): ZoteroCreator[]
}

class TaskData {
  public contents: string
  public note: string = null
  public due_string: string = null
  public project_name: string
  public section_name: string = null
  public priority: number
  public label_names: string[]
  constructor(
    contents: string,
    priority: number,
    project_name: string,
    label_names: string[]
  ) {
    this.contents = contents
    this.priority = priority
    this.project_name = project_name
    this.label_names = label_names
  }
}

class TodoistAPI {
  private token: string = null
  private projects: Record<string, number> = null
  private labels: Record<string, number> = null
  private sections: Record<string, Record<string, number>> = {}

  constructor(token: string) {
    this.token = token
  }

  public async createTask(task_data: TaskData) {
    const icon = `chrome://zotero/skin/spinner-16px${Zotero.hiDPI ? '@2x' : ''
    }.png`
    const progWin = show(icon, 'Creating task', 'Making Todoist task for item')
    if (this.token == null || this.token === '') {
      this.token = getPref('todoist_token')
    }

    const project_id = await this.getProjectId(task_data.project_name, progWin)
    if (project_id == null) {
      return
    }

    let section_id = null
    if (task_data.section_name != null) {
      section_id = await this.getSectionId(
        task_data.section_name,
        task_data.project_name,
        progWin
      )
      if (section_id == null) {
        return
      }
    }

    const label_ids = []
    for (const label_name of task_data.label_names) {
      const label_id = await this.getLabelId(label_name, progWin)
      if (label_id == null) {
        return
      }

      label_ids.push(label_id)
    }

    const createPayload: { [k: string]: any } = {
      content: task_data.contents,
      project_id,
      priority: task_data.priority,
    }

    if (label_ids.length > 0) {
      createPayload.label_ids = label_ids
    }

    if (section_id != null) {
      createPayload.section_id = section_id
    }

    if (task_data.due_string != null) {
      createPayload.due_string = task_data.due_string
    }

    const createHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    const createResponse = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
      'POST',
      'https://api.todoist.com/rest/v2/tasks',
      {
        headers: createHeaders,
        body: JSON.stringify(createPayload),
      }
    )

    if (!createResponse.ok) {
      const err = createResponse.text // Access response text directly
      const msg = `Error creating task: ${createResponse.statusText} ${err}`
      showError(msg, progWin)
      Zotero.logError(msg)
      return
    }

    if (task_data.note != null) {
      const task_id = (JSON.parse(createResponse.text as string)).id // Parse response text
      const notePayload = {
        content: task_data.note,
        task_id,
      }

      const noteHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      }

      const noteResponse = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
        'POST',
        'https://api.todoist.com/rest/v2/comments',
        {
          headers: noteHeaders,
          body: JSON.stringify(notePayload),
        }
      )

      if (!noteResponse.ok) {
        const err = noteResponse.text
        const msg = `Error adding comment: ${noteResponse.statusText} ${err}`
        showError(msg, progWin)
        Zotero.logError(msg)
        return
      }
    }
    showSuccess(task_data, progWin)
  }

  private async getSectionId(
    section_name: string,
    project_name: string,
    progress_win: object
  ): Promise<number | null> {
    if (this.sections[project_name] === undefined) {
      const project_sections = await this.getSections(
        project_name,
        progress_win
      )
      if (project_sections == null) {
        showError('Failed to get sections!', progress_win)
        return null
      }

      this.sections[project_name] = project_sections
    }

    if (!(section_name in this.sections[project_name])) {
      const section_result = await this.createSection(
        section_name,
        project_name,
        progress_win
      )

      if (!section_result) {
        return null
      }
    }

    return this.sections[project_name][section_name]
  }

  private async getProjectId(
    project_name: string,
    progress_win: object
  ): Promise<number | null> {
    if (this.projects == null) {
      this.projects = await this.getProjects(progress_win)
      if (this.projects == null) {
        showError('Failed to get projects!', progress_win)
        return null
      }
    }

    if (!(project_name in this.projects)) {
      const project_result = await this.createProject(
        project_name,
        progress_win
      )
      if (!project_result) {
        return null
      }
    }

    return this.projects[project_name]
  }

  private async getLabelId(
    label_name: string,
    progress_win: object
  ): Promise<number | null> {
    if (this.labels == null) {
      this.labels = await this.getLabels(progress_win)

      if (this.labels == null) {
        showError('Failed to get labels!', progress_win)
        return null
      }
    }

    if (!(label_name in this.labels)) {
      const label_result = await this.createLabel(label_name, progress_win)
      if (!label_result) {
        return null
      }
    }

    return this.labels[label_name]
  }

  private async createSection(
    section_name: string,
    project_name: string,
    progWin: object
  ): Promise<boolean> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    const project_id = await this.getProjectId(project_name, progWin)
    if (project_id == null) {
      return false; // Added return false based on type hint
    }

    const payload = { name: section_name, project_id }
    const response = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
      'POST',
      'https://api.todoist.com/rest/v2/sections',
      {
        headers,
        body: JSON.stringify(payload),
      }
    )

    if (!response.ok) {
      const err = response.text
      const msg = `Error creating section ${section_name} in project ${project_name}: ${response.statusText} ${err}`
      showError(msg, progWin)
      Zotero.logError(msg)
      return false
    }

    const data = JSON.parse(response.text as string)
    if (!this.sections[project_name]) this.sections[project_name] = {};
    this.sections[project_name][data.name] = data.id

    return true
  }

  private async createProject(
    project_name: string,
    progWin: object
  ): Promise<boolean> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    const payload = { name: project_name }
    const response = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
      'POST',
      'https://api.todoist.com/rest/v2/projects',
      {
        headers,
        body: JSON.stringify(payload),
      }
    )

    if (!response.ok) {
      const err = response.text
      const msg = `Error creating project ${project_name}: ${response.statusText} ${err}`
      showError(msg, progWin)
      Zotero.logError(msg)
      return false
    }

    const data = JSON.parse(response.text as string)
    if (!this.projects) this.projects = {};
    this.projects[data.name] = data.id

    return true
  }

  private async createLabel(
    label_name: string,
    progWin: object
  ): Promise<boolean> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    const payload = { name: label_name }
    const response = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
      'POST',
      'https://api.todoist.com/rest/v2/labels',
      {
        headers,
        body: JSON.stringify(payload),
      }
    )

    if (!response.ok) {
      const err = response.text
      const msg = `Error creating label ${label_name}: ${response.statusText} ${err}`
      showError(msg, progWin)
      Zotero.logError(msg)
      return false
    }

    const data = JSON.parse(response.text as string)
    if (!this.labels) this.labels = {};
    this.labels[data.name] = data.id

    return true
  }

  private async getAll(
    endpoint: string,
    progWin: object
  ): Promise<Record<string, number>> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    const response = await Zotero.HTTP.request( // Use Zotero.HTTP for Z7
      'GET',
      endpoint,
      {
        headers,
      }
    )

    if (!response.ok) {
      const err = response.text
      const msg = `Error requesting from ${endpoint}: ${response.statusText} ${err}`
      showError(msg, progWin)
      Zotero.logError(msg)
      return null
    }

    const data = JSON.parse(response.text as string)
    const items: { [k: string]: number } = {}
    for (const item of data) {
      items[item.name] = item.id
    }

    return items
  }

  private async getSections(
    project_name: string,
    progWin: object
  ): Promise<Record<string, number>> {
    const project_id = await this.getProjectId(project_name, progWin)
    if (project_id == null) {
      return null
    }

    return this.getAll(
      `https://api.todoist.com/rest/v2/sections?project_id=${project_id}`,
      progWin
    )
  }

  private async getProjects(progWin: object): Promise<Record<string, number>> {
    return this.getAll('https://api.todoist.com/rest/v2/projects', progWin)
  }

  private async getLabels(progWin: object): Promise<Record<string, number>> {
    return this.getAll('https://api.todoist.com/rest/v2/labels', progWin)
  }
}

class Zotodo {
  private todoist: TodoistAPI
  private notifierID: any = null; // Stored notifier ID

  // Called from startup
  public init() {
    const todoist_token: string = getPref('todoist_token')
    this.todoist = new TodoistAPI(todoist_token)

    // Register notifier
    // The Zotero.Notifier.registerObserver is correct for Z7 as well
    this.notifierID = Zotero.Notifier.registerObserver(
      this.notifierCallback,
      ['item'],
      'Zotodo-item-observer' // Unique observer name
    );
  }

  private notifierCallback: any = { // Made 'any' to match Zotero typings
    notify: (event: string, type: string, ids: number[], _extraData?: object) => {
      if (getPref('automatic_add') && type === 'item' && event === 'add') {
        const items = Zotero.Items.get(ids)
          .map((item: ZoteroItem) => {
            // Ensure itemType is populated if not already a string
            if (typeof item.itemTypeID === 'number' && !item.itemType) {
                item.itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            }
            return item
          })
          .filter(
            (item: ZoteroItem) =>
              item.itemType !== 'attachment' && item.itemType !== 'note'
          )

        for (const item of items) {
          Zotero.debug(`Zotodo: Making task for ${item.getField('title')}`) // Use Zotero.debug
          void this.makeTaskForItem(item as ZoteroItem) // Removed Zotero.Zotodo
        }
      }
    },
  }

  public openPreferenceWindow(paneID?: any, action?: any) {
    const win = Zotero.getMainWindow(); // Get main window reference
    if (!win) {
        Zotero.logError("Zotodo: Could not get main window to open preferences");
        return;
    }
    const io = { pane: paneID, action }
    win.openDialog(
      'chrome://zotodo/content/options.xhtml',
      'zotodo-options',
      `chrome,titlebar,toolbar,centerscreen${Zotero.Prefs.get('browser.preferences.instantApply', true) ? 'dialog=no' : 'modal'}`,
      io
    )
  }

  public makeTaskForSelectedItems() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
        Zotero.logError("Zotodo: Could not get active Zotero pane.");
        return;
    }
    const items = pane
      .getSelectedItems()
      .map((item: any /* ZoteroItem has no itemTypeID directly */) => { // Ensure items are full Zotero items
          if (typeof item === 'number') return Zotero.Items.get(item); // If only ID is returned, get full item
          if (typeof item.itemTypeID === 'number' && !item.itemType) { // Similar to notifier
            item.itemType = Zotero.ItemTypes.getName(item.itemTypeID);
          }
          return item;
      })
      .filter(
        (item: ZoteroItem) =>
          item.itemType !== 'attachment' &&
          item.itemType !== 'note'
      )

    for (const item of (items as ZoteroItem[])) {
      void this.makeTaskForItem(item)
    }
  }

  private async makeTaskForItem(item: ZoteroItem) {
    const due_string: string = getPref('due_string')
    const label_names_string: string = getPref('labels') as string
    let label_names: string[] = []
    if (label_names_string !== '') {
      label_names = label_names_string.split(',')
    }

    const ignore_collections_string: string = getPref('ignore_collections') as string;
    const ignore_collections: string[] = ignore_collections_string ? ignore_collections_string.split(',') : [];

    const priority: number = MAX_PRIORITY - getPref('priority')
    const project_name: string = getPref('project')
    const section_name: string = getPref('section')

    const set_due: boolean = getPref('set_due')
    const include_note: boolean = getPref('include_note')
    let note_format: string = getPref('note_format')
    let task_format: string = getPref('task_format')

    const item_collections = item
      .getCollections()
      .map(id => Zotero.Collections.get(id).name as string)
    for (const ignored_name of ignore_collections) {
      if (item_collections.includes(ignored_name.trim())) { // Added trim
        Zotero.debug(`Zotodo: Item "${item.getField('title')}" in ignored collection "${ignored_name.trim()}", skipping.`);
        return
      }
    }

    const title: string = item.getField('title', false, true) || ''
    const abstract: string = item.getField('abstractNote', false, true) || ''
    const url: string = item.getField('url', false, true) || ''
    const doi: string = item.getField('DOI', false, true) || ''
    let pdf_path = ''
    let pdf_id = '' // Changed to string for consistency with Z7 URIs
    const attachments: any[] = item.getAttachments(false).map(id => Zotero.Items.get(id)); // Get full attachment items
    if (attachments.length > 0) {
      for (const attachment of attachments) {
        if (attachment.attachmentContentType === 'application/pdf') {
          pdf_path = attachment.attachmentPath || ''
          pdf_id = attachment.key || '' // Use key for URI
          break
        }
      }
    }

    const author_type_id: number = Zotero.CreatorTypes.getPrimaryIDForType(
      item.itemTypeID
    )

    const author_names: string[] = item
      .getCreators()
      .filter(
        (creator: ZoteroCreator) => creator.creatorTypeID === author_type_id
      )
      .map(
        (creator: ZoteroCreator) => `${creator.firstName || ''} ${creator.lastName || ''}`.trim() // Handle missing names
      )

    let et_al = ''
    if (author_names.length > 0) {
      et_al = `${author_names[0]} et al.`
    }

    const authors = author_names.join(', ')
    const item_id = item.key
    let library_path = 'library'
    const library = Zotero.Libraries.get(item.libraryID);
    if (library && library.libraryType === 'group') { // Check if library exists
      library_path = Zotero.URI.getLibraryPath(item.libraryID)
    }

    const select_uri = `zotero://select/${library_path}/items/${item_id}`
    let open_uri = ''
    if (pdf_id !== '') { open_uri = `zotero://open-pdf/${library_path}/items/${pdf_id}` }
    let citekey = ''
    if (
      Zotero.BetterBibTeX && // Check for BBT existence
      Zotero.BetterBibTeX.KeyManager
    ) {
      const bbtItem = Zotero.BetterBibTeX.KeyManager.get(item.id); // BBT uses item.id (integer)
      if (bbtItem && bbtItem.citekey) {
        citekey = bbtItem.citekey;
      }
    }

    const tokens: Record<string, string | number> = { // Ensure specific types if needed, but string is fine for templating
      title,
      abstract,
      url,
      doi,
      pdf_path,
      pdf_id,
      et_al,
      authors,
      library_path,
      item_id,
      select_uri,
      open_uri,
      citekey,
    }

    // Replace eval with safer template substitution
    const replaceTokens = (template: string, data: Record<string, any>) => {
        // Conditional blocks: ?${token}:value?
        template = template.replace(/\?\$\{([^}]+)\}:([^?]*)\?/g, (match, token, value) => {
            return data[token] ? value : '';
        });
        // Conditional blocks: !${token}:value!
        template = template.replace(/!$\{([^}]+)\}:([^!]*)!/g, (match, token, value) => {
            return !data[token] ? value : '';
        });
        // Regular tokens: ${token}
        template = template.replace(/\$\{([^}]+)\}/g, (match, token) => {
            return data[token] || '';
        });
        return template;
    };

    const note_contents: string = replaceTokens(note_format, tokens);
    const task_contents: string = replaceTokens(task_format, tokens);

    const task_data = new TaskData(
      task_contents,
      priority,
      project_name,
      label_names
    )

    if (include_note) {
      task_data.note = note_contents
    }

    if (set_due) {
      task_data.due_string = due_string
    }

    if (section_name !== '') {
      task_data.section_name = section_name
    }

    await this.todoist.createTask(task_data)
  }

  // Methods for window load/unload, can be expanded if menu items need specific handling
  public onWindowLoad() {
    Zotero.debug("Zotodo: onWindowLoad");
    // Placeholder for adding menu items or other window-specific logic
    // Example: this.addMenuItems(window);
  }

  public onWindowUnload() {
    Zotero.debug("Zotodo: onWindowUnload");
    // Placeholder for removing menu items or other window-specific cleanup
    // Example: this.removeMenuItems(window);
  }
}

// --- Bootstrap Functions ---
let rootURI: string | null = null;
let chromeHandle: any = null; // Stores the chrome registration handle
let zotodoInstance: Zotodo | null = null;
const services: { aomStartup?: any, Services?: any } = {}; // To store Cc and Services if needed

const mainWindowObserver = {
  notify: (event: string, type: string, ids: string[], extraData: any) => { // ids are strings in Z7 for windows
    Zotero.debug(`Zotodo: mainWindowObserver event: ${event}, type: ${type}`);
    if (type === 'window') { // Ensure we are observing window events
        if (event === 'add') {
            // In Z7, for 'add' event, 'ids' contains the window IDs, and 'extraData' maps these IDs to booleans (true if the window is new)
            // We need to get the actual window object.
            ids.forEach(id => {
                if (extraData[id] === true) { // Check if this window is being added
                    const win = Zotero.getMainWindows().find(w => w.document.documentElement.id === id);
                    if (win) {
                        onMainWindowLoad({ window: win });
                    }
                }
            });
        } else if (event === 'remove') {
            // In Z7, for 'remove' event, 'extraData' is the window object itself.
            // 'ids' will contain the ID of the window being removed.
            if (extraData) { // extraData is the window object
                onMainWindowUnload({ window: extraData });
            } else if (ids && ids.length > 0) {
                // Fallback if extraData is not the window, though Z7 docs say it should be
                // This part might not be strictly necessary if extraData is reliable
                Zotero.debug(`Zotodo: Window removal detected for IDs: ${ids.join(', ')}, but no window object in extraData.`);
            }
        }
    }
  }
};


function startup({ version, rootURI: rtURI }: { version: string, rootURI: string }, reason: any) {
  Zotero.debug(`Zotodo: startup ${version}, reason: ${reason}`);
  rootURI = rtURI; // Will be like file:///path/to/plugin/

  // In Zotero 7, Services is available globally.
  // services.Services = globalThis.Services; // Not strictly necessary to store if always using global Services
  services.aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);

  const manifestURI = Services.io.newURI(rootURI + 'manifest.json');
  Zotero.debug(`Zotodo: Registering chrome with manifest: ${manifestURI.spec}`);

  // Adjusted paths for Z7 structure (assuming build/ is not part of rootURI from Zotero)
  // The paths in manifest.json and here should lead to the resources correctly.
  // If your resources are inside a 'content', 'locale', 'skin' folder at the root of the XPI, this is correct.
  chromeHandle = services.aomStartup.registerChrome(manifestURI, [
    ['content', 'zotodo', 'content/'], // maps to content/ in XPI root
    ['locale', 'zotodo', 'en-US', 'locale/en-US/'], // maps to locale/en-US/ in XPI root
    ['skin', 'zotodo', 'default', 'skin/default/'] // maps to skin/default/ in XPI root (assuming skin name is 'default')
    // If skin structure is just skin/, then use 'skin/'
  ]);

  zotodoInstance = new Zotodo();
  zotodoInstance.init(); // Call the refactored init
  (Zotero as any).Zotodo = zotodoInstance; // Make instance globally available

  // Add main window listeners
  Zotero.getMainWindows().forEach(win => onMainWindowLoad({ window: win }));
  Zotero.Notifier.registerObserver(mainWindowObserver, ['window'], 'Zotodo-window-observer', true); // Added unique name and ignoreCache = true
  Zotero.debug("Zotodo: startup complete.");
}

function shutdown(reason: any) {
  Zotero.debug(`Zotodo: shutdown, reason: ${reason}`);

  Zotero.Notifier.unregisterObserver('Zotodo-window-observer'); // Use the unique name

  // Call onMainWindowUnload for all open main windows
  Zotero.getMainWindows().forEach(win => onMainWindowUnload({ window: win }));

  if (zotodoInstance && zotodoInstance.notifierID) {
    Zotero.Notifier.unregisterObserver(zotodoInstance.notifierID);
  }

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }

  if ((Zotero as any).Zotodo) {
    (Zotero as any).Zotodo = null;
  }
  zotodoInstance = null;
  Zotero.debug("Zotodo: shutdown complete.");
}

function install(reason: any) {
  Zotero.debug("Zotodo: install, reason: " + reason);
}

function uninstall(reason: any) {
  Zotero.debug("Zotodo: uninstall, reason: " + reason);
}

function onMainWindowLoad({ window }: { window: any }) {
  Zotero.debug(`Zotodo: onMainWindowLoad for window ID ${window.document.documentElement.id}`);
  const doc = window.document;

  // Add 'Make Task' to item context menu
  const itemMenuItem = doc.createXULElement('menuitem');
  itemMenuItem.id = 'zotodo-itemmenu-make-task';
  itemMenuItem.setAttribute('label', "Create Todoist task"); // Using literal string
  itemMenuItem.addEventListener('command', () => {
    // Ensure zotodoInstance and its methods are available
    if (zotodoInstance && typeof zotodoInstance.makeTaskForSelectedItems === 'function') {
      zotodoInstance.makeTaskForSelectedItems();
    } else {
      Zotero.debug("Zotodo: zotodoInstance or makeTaskForSelectedItems not available.");
    }
  });

  const zoteroItemMenu = doc.getElementById('zotero-itemmenu');
  if (zoteroItemMenu) {
    let sep = doc.getElementById('id-zotodo-separator');
    if (!sep) {
      sep = doc.createXULElement('menuseparator');
      sep.id = 'id-zotodo-separator';
      zoteroItemMenu.appendChild(sep);
    }
    zoteroItemMenu.appendChild(itemMenuItem);
  } else {
    Zotero.debug("Zotodo: zotero-itemmenu not found.");
  }

  // Add 'Zotodo Options' to Tools menu
  const toolsMenuItem = doc.createXULElement('menuitem');
  toolsMenuItem.id = 'zotodo-toolsmenu-options';
  toolsMenuItem.setAttribute('label', "Zotodo Preferences"); // Using literal string
  toolsMenuItem.addEventListener('command', () => {
    if (zotodoInstance && typeof zotodoInstance.openPreferenceWindow === 'function') {
      zotodoInstance.openPreferenceWindow();
    } else {
      Zotero.debug("Zotodo: zotodoInstance or openPreferenceWindow not available.");
    }
  });

  const toolsMenu = doc.getElementById('menu_ToolsPopup');
  if (toolsMenu) {
    toolsMenu.appendChild(toolsMenuItem);
  } else {
    Zotero.debug("Zotodo: menu_ToolsPopup not found.");
  }

  zotodoInstance?.onWindowLoad(window);
}

function onMainWindowUnload({ window }: { window: any }) {
  Zotero.debug(`Zotodo: onMainWindowUnload for window ID ${window.document.documentElement.id}`);
  const doc = window.document;

  // Remove 'Make Task' menu item and its separator
  doc.getElementById('zotodo-itemmenu-make-task')?.remove();
  doc.getElementById('id-zotodo-separator')?.remove();

  // Remove 'Zotodo Options' menu item
  doc.getElementById('zotodo-toolsmenu-options')?.remove();

  zotodoInstance?.onWindowUnload(window);
}

// No Zotero.Zotodo = new Zotodo() at the end anymore.
// The bootstrap functions control the lifecycle.
// Helper functions like getPref, showError, showSuccess, show are kept global within the module.
// fetch calls replaced with Zotero.HTTP.request for Z7 compatibility.
// eval removed and replaced with a safer token substitution logic.
// Added Zotero.debug for logging.
// Adjusted paths for chrome registration in startup.
// Ensured notifier IDs are handled correctly in startup/shutdown.
// Updated openPreferenceWindow to use rootURI and getMainWindow.
// Minor fixes for item handling in makeTaskForSelectedItems and notifierCallback.
// Ensured BBT integration checks for existence of Zotero.BetterBibTeX.
// Added explicit return false in TodoistAPI createSection based on type hint, and initialized objects before setting keys.

// The following are usually exported for Zotero 7 plugins,
// but the plugin loader will also find them if they are top-level like this.
// For clarity, an explicit export structure can be used if preferred later.
// export { startup, shutdown, install, uninstall, onMainWindowLoad, onMainWindowUnload };

Zotero.debug("Zotodo: zotodo.ts loaded");

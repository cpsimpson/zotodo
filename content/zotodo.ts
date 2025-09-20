declare const Zotero: any
declare const Services: any
declare const Components: any;
const { classes: Cc, interfaces: Ci } = Components;

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

interface TodoistApiItem {
  name: string
  id: number
}

class TaskData {
  public contents: string
  public note: string = null
  public due_string: string = null
  public project_name: string
  public section_name: string = null
  public priority: number
  public label_names: string[]
  public description: string = null
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
    this.token = (token || '').trim()
  }

  public async createTask(task_data: TaskData) {
    const icon = `chrome://zotero/skin/spinner-16px${Zotero.hiDPI ? '@2x' : ''}.png`
    const progWin = show(icon, 'Creating task', 'Making Todoist task for item')

    try {
      if (this.token == null || this.token === '') {
        this.token = getPref('todoist_token')
      }
      this.token = (this.token || '').trim()
      if (!this.token || this.token.length < 10) {
        const msg = 'Zotodo: Todoist API token appears missing or invalid (length ' + String(this.token ? this.token.length : 0) + '). Set it in Zotodo preferences.'
        showError(msg, progWin)
        try { Zotero.logError(msg) } catch (_ee) {}
        return
      }

      const project_id = await this.getProjectId(task_data.project_name, progWin)
      if (project_id == null) return

      let section_id = null
      if (task_data.section_name != null) {
        section_id = await this.getSectionId(
          task_data.section_name,
          task_data.project_name,
          progWin
        )
        if (section_id == null) return
      }

      const label_ids = []
      for (const label_name of task_data.label_names) {
        const label_id = await this.getLabelId(label_name, progWin)
        if (label_id == null) return
        label_ids.push(label_id)
      }

      const createPayload: { [k: string]: any } = {
        content: task_data.contents,
        project_id,
        priority: task_data.priority,
      }
      if (task_data.description) createPayload.description = task_data.description
      if (label_ids.length > 0) createPayload.label_ids = label_ids
      if (section_id != null) createPayload.section_id = section_id
      if (task_data.due_string != null) createPayload.due_string = task_data.due_string

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      }

      const normalize = (resp: any) => {
        const status = typeof resp?.status === 'number' ? resp.status : (typeof resp?.response?.status === 'number' ? resp.response.status : 0)
        const text = (resp && (resp.responseText != null)) ? resp.responseText : (resp && resp.text != null ? resp.text : '')
        const statusText = resp?.statusText || ''
        const ok = (typeof resp?.ok === 'boolean') ? resp.ok : (status >= 200 && status < 300)
        return { status, statusText, text, ok }
      }

      const createRespRaw = await Zotero.HTTP.request('POST', 'https://api.todoist.com/rest/v2/tasks', { headers, body: JSON.stringify(createPayload) })
      const createResp = normalize(createRespRaw)
      if (!createResp.ok) {
        const msg = `Error creating task: ${createResp.status} ${createResp.statusText} ${createResp.text}`
        showError(msg, progWin)
        Zotero.logError(msg)
        return
      }

      if (task_data.note != null) {
        let task_id: any = null
        try {
          task_id = (JSON.parse(String(createResp.text))).id
        } catch (e) {
          const msg = 'Error parsing create task response for task ID: ' + (e && (e.message || String(e)))
          showError(msg, progWin)
          Zotero.logError(msg)
          return
        }

        const notePayload = { content: task_data.note, task_id }
        const noteRespRaw = await Zotero.HTTP.request('POST', 'https://api.todoist.com/rest/v2/comments', { headers, body: JSON.stringify(notePayload) })
        const noteResp = normalize(noteRespRaw)
        if (!noteResp.ok) {
          const msg = `Error adding comment: ${noteResp.status} ${noteResp.statusText} ${noteResp.text}`
          showError(msg, progWin)
          Zotero.logError(msg)
          return
        }
      }

      showSuccess(task_data, progWin)
    } catch (e3) {
      const msg = 'Zotodo: createTask failed: ' + (e3 && (e3.stack || e3.message || String(e3)))
      try { Zotero.logError(msg) } catch (_ee) {}
      try { Zotero.debug(msg) } catch (_ee2) {}
      try { Components.utils.reportError(msg) } catch (_ee3) {}
      try { showError('Failed to create task. See Browser Console for details.', progWin) } catch (_ee4) {}
    }
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
      return false // Added return false based on type hint
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
    if (!this.sections[project_name]) this.sections[project_name] = {}
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
    if (!this.projects) this.projects = {}
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
    if (!this.labels) this.labels = {}
    this.labels[data.name] = data.id

    return true
  }

  private async getAll(
    endpoint: string,
    progWin: object
  ): Promise<Record<string, number> | null> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }

    let status = 0
    let statusText = ''
    let text = ''

    try {
      const resp: any = await Zotero.HTTP.request('GET', endpoint, { headers })
      // Zotero.HTTP returns an object; normalize fields
      status = typeof resp?.status === 'number' ? resp.status : (typeof resp?.response?.status === 'number' ? resp.response.status : 0)
      statusText = resp?.statusText || ''
      text = (resp && (resp.responseText != null)) ? String(resp.responseText) : (resp && resp.text != null ? String(resp.text) : '')
      const ok = (typeof resp?.ok === 'boolean') ? resp.ok : (status >= 200 && status < 300)
      if (!ok) throw { status, statusText, text }
    } catch (e: any) {
      status = e?.status || status
      statusText = e?.statusText || statusText
      text = e?.text || text
      let hint = ''
      if (status === 401 || status === 403) hint = ' (Unauthorized — check your Todoist API token in Zotodo preferences)'
      const msg = `Error requesting from ${endpoint}: ${status} ${statusText} ${text}${hint}`
      showError(msg, progWin)
      try { Zotero.logError(msg) } catch (_ee) {}
      return null
    }

    let data: TodoistApiItem[] = []
    try {
      data = JSON.parse(text) as TodoistApiItem[]
    } catch (e) {
      const msg = `Error parsing response from ${endpoint}: ${String(e && (e.message || e))}`
      showError(msg, progWin)
      try { Zotero.logError(msg) } catch (_ee) {}
      return null
    }

    const items: { [k: string]: number } = {}
    for (const item of data) {
      items[item.name] = item.id
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return items
  }

  private async getSections(
    project_name: string,
    progWin: object
  ): Promise<Record<string, number> | null> {
    const project_id = await this.getProjectId(project_name, progWin)
    if (project_id == null) {
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await this.getAll(
      `https://api.todoist.com/rest/v2/sections?project_id=${project_id}`,
      progWin
    )
  }

  private async getProjects(progWin: object): Promise<Record<string, number> | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await this.getAll('https://api.todoist.com/rest/v2/projects', progWin)
  }

  private async getLabels(progWin: object): Promise<Record<string, number>> {
    return this.getAll('https://api.todoist.com/rest/v2/labels', progWin)
  }
}

class Zotodo {
  private todoist: TodoistAPI
  public notifierID: any = null // Stored notifier ID

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
    )
  }

  private notifierCallback: any = { // Made 'any' to match Zotero typings
    notify: (event: string, type: string, ids: number[], _extraData?: object) => {
      if (getPref('automatic_add') && type === 'item' && event === 'add') {
        const items = Zotero.Items.get(ids)
          .map((item: ZoteroItem) => {
            // Ensure itemType is populated if not already a string
            if (typeof item.itemTypeID === 'number' && !item.itemType) {
              item.itemType = Zotero.ItemTypes.getName(item.itemTypeID)
            }
            return item
          })
          .filter(
            (item: ZoteroItem) =>
              item.itemType !== 'attachment' && item.itemType !== 'note'
          )

        for (const item of items) {
          Zotero.debug(`Zotodo: Making task for ${item.getField('title')}`) // Use Zotero.debug
          void this.makeTaskForItem(item as ZoteroItem); // Removed Zotero.Zotodo
        }
      }
    },
  }

  public openPreferenceWindow(paneID?: any, action?: any) {
    const win = Zotero.getMainWindow()
    if (!win) {
      Zotero.logError('Zotodo: Could not get main window to open preferences')
      return
    }
    const io = { pane: paneID, action }
    const features = `chrome,titlebar,toolbar,centerscreen${Zotero.Prefs.get('browser.preferences.instantApply', true) ? 'dialog=no' : 'modal'}`

    // Prefer rootURI (jar/file) to avoid reliance on chrome registration in Zotero 8
    try {
      const url = (rootURI && typeof rootURI === 'string') ? (rootURI + 'content/options.xhtml') : null
      if (url) {
        win.openDialog(url, 'zotodo-options', features, io)
        return
      }
    } catch (eRoot) {
      try { Zotero.debug('Zotodo: preferences rootURI open failed, will try chrome:// as fallback: ' + (eRoot && (eRoot.message || String(eRoot)))) } catch (_e) {}
    }

    // Fallback to chrome:// if rootURI was not available or failed
    try {
      win.openDialog('chrome://zotodo/content/options.xhtml', 'zotodo-options', features, io)
      return
    } catch (eChrome) {
      const msg = 'Zotodo: preferences open failed (both rootURI and chrome): ' + (eChrome && (eChrome.message || String(eChrome)))
      try { Zotero.logError(msg) } catch (_ee) {}
      try { Zotero.debug(msg) } catch (_ee2) {}
      try { Components.utils.reportError(msg) } catch (_ee3) {}
      try { win.alert('Zotodo: preferences UI not available; see Browser Console for details') } catch (_ee4) {}
    }
  }

  public makeTaskForSelectedItems() {
    const pane = Zotero.getActiveZoteroPane()
    if (!pane) {
      Zotero.logError('Zotodo: Could not get active Zotero pane.')
      return
    }
    const items = pane
      .getSelectedItems()
      .map((item: any /* ZoteroItem has no itemTypeID directly */) => { // Ensure items are full Zotero items
        if (typeof item === 'number') return Zotero.Items.get(item) // If only ID is returned, get full item
        if (typeof item.itemTypeID === 'number' && !item.itemType) { // Similar to notifier
          item.itemType = Zotero.ItemTypes.getName(item.itemTypeID)
        }
        return item
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
    try {
      Zotero.debug('Zotodo: makeTaskForItem begin')
      // Coerce preferences to safe defaults to avoid runtime errors when unset
      const due_string_raw: any = getPref('due_string')
      const due_string: string = (typeof due_string_raw === 'string') ? due_string_raw : ''
      const label_names_string_raw: any = getPref('labels')
      const label_names_string: string = (typeof label_names_string_raw === 'string') ? label_names_string_raw : ''
      let label_names: string[] = []
      if (label_names_string.trim() !== '') {
        label_names = label_names_string.split(',').map(s => s.trim()).filter(s => s.length)
      }

      const ignore_collections_string_raw: any = getPref('ignore_collections')
      const ignore_collections_string: string = (typeof ignore_collections_string_raw === 'string') ? ignore_collections_string_raw : ''
      const ignore_collections: string[] = ignore_collections_string ? ignore_collections_string.split(',').map(s => s.trim()).filter(s => s.length) : []

      const userPriorityRaw: any = getPref('priority')
      let userPriority = Number(userPriorityRaw)
      if (!Number.isFinite(userPriority) || userPriority < 1 || userPriority > 4) userPriority = 1
      const priority: number = MAX_PRIORITY - userPriority
      const project_name_raw: any = getPref('project')
      const project_name: string = (typeof project_name_raw === 'string' && project_name_raw.trim() !== '') ? project_name_raw : 'Reading Queue'
      const section_name_raw: any = getPref('section')
      const section_name: string = (typeof section_name_raw === 'string') ? section_name_raw : ''

      const set_due: boolean = Boolean(getPref('set_due'))
      const include_note: boolean = Boolean(getPref('include_note'))
      const note_format_raw: any = getPref('note_format')
      const note_format: string = (typeof note_format_raw === 'string') ? note_format_raw : ''
      const task_format_raw: any = getPref('task_format')
      const task_format: string = (typeof task_format_raw === 'string' && task_format_raw.trim() !== '') ? task_format_raw : '${title}'

      Zotero.debug('Zotodo: before getCollections for item ' + String((item as any)?.id || (item as any)?.key))
      const item_collections = (typeof item.getCollections === 'function' ? item.getCollections() : [])
        .map(id => {
          const col = Zotero.Collections && Zotero.Collections.get ? Zotero.Collections.get(id) : null
          return col ? (col.name as string) : ''
        })
      for (const ignored_name of ignore_collections) {
        if (item_collections.includes(ignored_name.trim())) {
          Zotero.debug(`Zotodo: Item "${item.getField('title')}" in ignored collection "${ignored_name.trim()}", skipping.`)
          return
        }
      }
      Zotero.debug('Zotodo: makeTaskForItem after collections check')

      const title: string = item.getField('title', false, true) || ''
      const abstract: string = item.getField('abstractNote', false, true) || ''
      const url: string = item.getField('url', false, true) || ''
      const doi: string = item.getField('DOI', false, true) || ''
      let pdf_path = ''
      let pdf_id = ''
      const attachments: any[] = item.getAttachments(false).map(id => Zotero.Items.get(id))
      if (attachments.length > 0) {
        for (const attachment of attachments) {
          if (attachment.attachmentContentType === 'application/pdf') {
            pdf_path = attachment.attachmentPath || ''
            pdf_id = attachment.key || ''
            break
          }
        }
      }

      const author_type_id: any = (typeof item.itemTypeID === 'number') ? Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID) : null
      const creators: ZoteroCreator[] = (typeof item.getCreators === 'function' && item.getCreators()) ? item.getCreators() : []
      const author_names: string[] = (author_type_id != null ? creators.filter((c: ZoteroCreator) => c.creatorTypeID === author_type_id) : creators)
        .map((creator: ZoteroCreator) => `${creator.firstName || ''} ${creator.lastName || ''}`.trim())

      let et_al = ''
      if (author_names.length > 0) et_al = `${author_names[0]} et al.`
      Zotero.debug('Zotodo: makeTaskForItem after authors build')

      const authors = author_names.join(', ')
      const item_id = item.key
      let library_path = 'library'
      const library = Zotero.Libraries.get(item.libraryID)
      if (library && library.libraryType === 'group') {
        library_path = Zotero.URI.getLibraryPath(item.libraryID)
      }

      const select_uri = `zotero://select/${library_path}/items/${item_id}`
      let open_uri = ''
      if (pdf_id !== '') open_uri = `zotero://open-pdf/${library_path}/items/${pdf_id}`
      let citekey = ''
      if (Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager) {
        const bbtItem = Zotero.BetterBibTeX.KeyManager.get(item.id)
        if (bbtItem && bbtItem.citekey) citekey = bbtItem.citekey
      }

      const tokens: Record<string, string | number> = {
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

      const replaceTokens = (template: string, data: Record<string, any>): string => {
        template = template.replace(/\?\$\{([^}]+)\}:([^?]*)\?/g, (match: string, token: string, value: string): string => data[token] ? value : '')
        template = template.replace(/!\$\{([^}]+)\}:([^!]*)!/g, (match: string, token: string, value: string): string => !data[token] ? value : '')
        template = template.replace(/\$\{([^}]+)\}/g, (match: string, token: string): string => String(data[token] || ''))
        return template
      }

      Zotero.debug('Zotodo: makeTaskForItem after tokens build')
      const note_contents: string = replaceTokens(note_format, tokens)
      const task_contents: string = replaceTokens(task_format, tokens)

      const task_data = new TaskData(task_contents, priority, project_name, label_names)
      if (include_note) task_data.note = note_contents
      if (set_due) task_data.due_string = due_string
      if (section_name !== '') task_data.section_name = section_name
      // Set description to the item's URL if available; fall back to DOI link if no URL but DOI present
      if (url && url.trim() !== '') {
        task_data.description = url.trim()
      } else if (doi && String(doi).trim() !== '') {
        task_data.description = 'https://doi.org/' + String(doi).trim()
      }

      Zotero.debug('Zotodo: makeTaskForItem before createTask')
      await this.todoist.createTask(task_data)
    } catch (e) {
      const msg = 'Zotodo: makeTaskForItem failed: ' + (e && (e.stack || e.message || String(e)))
      try { Zotero.logError(msg) } catch (_ee) {}
      try { Zotero.debug(msg) } catch (_ee2) {}
      try { Components.utils.reportError(msg) } catch (_ee3) {}
      try { Zotero.alert(null, 'Zotodo', 'Failed to prepare task; see Browser Console for details.') } catch (_ee4) {}
    }
  }

  // Methods for window load/unload, can be expanded if menu items need specific handling
  public onWindowLoad(window: any) {
    Zotero.debug('Zotodo: onWindowLoad')
    // Placeholder for adding menu items or other window-specific logic
    // Example: this.addMenuItems(window);
  }

  public onWindowUnload(window: any) {
    Zotero.debug('Zotodo: onWindowUnload')
    // Placeholder for removing menu items or other window-specific cleanup
    // Example: this.removeMenuItems(window);
  }
}

// --- Bootstrap Functions ---
let rootURI: string | null = null
let chromeHandle: any = null // Stores the chrome registration handle
let zotodoInstance: Zotodo | null = null
const services: { aomStartup?: any, Services?: any } = {} // To store Cc and Services if needed

const mainWindowObserver = {
  notify: (event: string, type: string, ids: string[], extraData: any) => { // ids are strings in Z7 for windows
    Zotero.debug(`Zotodo: mainWindowObserver event: ${event}, type: ${type}`)
    if (type === 'window') { // Ensure we are observing window events
      if (event === 'add') {
        // In Z7, for 'add' event, 'ids' contains the window IDs, and 'extraData' maps these IDs to booleans (true if the window is new)
        // We need to get the actual window object.
        ids.forEach(id => {
          if (extraData[id] === true) { // Check if this window is being added
            const win = Zotero.getMainWindows().find(w => w.document.documentElement.id === id)
            if (win) {
              onMainWindowLoad({ window: win })
            }
          }
        })
      }
      else if (event === 'remove') {
        // In Z7, for 'remove' event, 'extraData' is the window object itself.
        // 'ids' will contain the ID of the window being removed.
        if (extraData) { // extraData is the window object
          onMainWindowUnload({ window: extraData })
        }
        else if (ids && ids.length > 0) {
          // Fallback if extraData is not the window, though Z7 docs say it should be
          // This part might not be strictly necessary if extraData is reliable
          Zotero.debug(`Zotodo: Window removal detected for IDs: ${ids.join(', ')}, but no window object in extraData.`)
        }
      }
    }
  },
}


export function startup({ version, rootURI: rtURI }: { version: string, rootURI: string }, reason: unknown): void {
  Zotero.debug(`Zotodo: startup ${version}, reason: ${String(reason)}`)
  rootURI = rtURI // Will be like file:///path/to/plugin/

  // Install global unhandled promise rejection logger to track silent errors
  try {
    const handler = (event: any) => {
      try {
        const reason = event?.reason
        const msg = `Zotodo: Unhandled promise rejection: ${reason && (reason.stack || reason.message || String(reason))}`
        Zotero.logError(msg)
        Zotero.debug(msg)
      } catch (_e) { /* ignore */ }
    }
    ;(globalThis as any).addEventListener && (globalThis as any).addEventListener('unhandledrejection', handler)
  } catch (_e) { /* ignore */ }

  // In Zotero 7, Services is available globally.
  // services.Services = globalThis.Services; // Not strictly necessary to store if always using global Services
  services.aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup)

  try {
    if (rootURI) {
      // Build manifest URI using IOService to avoid reliance on global Services in Zotero 8
      const ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService)
      const manifestURI = ioService.newURI(`${rootURI}manifest.json`)
      Zotero.debug(`Zotodo: Registering chrome with manifest: ${manifestURI.spec}`)

      // Adjusted paths for Z7 structure (assuming build/ is not part of rootURI from Zotero)
      // The paths in manifest.json and here should lead to the resources correctly.
      // If your resources are inside a 'content', 'locale', 'skin' folder at the root of the XPI, this is correct.
      chromeHandle = services.aomStartup.registerChrome(manifestURI, [
        ['content', 'zotodo', 'content/'], // maps to content/ in XPI root
        ['locale', 'zotodo', 'en-US', 'locale/en-US/'], // maps to locale/en-US/ in XPI root
        ['skin', 'zotodo', 'default', 'skin/'], // maps to skin/ in XPI root
      ])
    }
    else {
      Zotero.debug('Zotodo: startup without rootURI; assuming chrome.manifest provided the chrome registrations')
    }
  }
  catch (e) {
    try { Zotero.logError('Zotodo: chrome registration skipped/failed: ' + (e && (e.message || String(e)))) } catch (_ee) {}
  }

  zotodoInstance = new Zotodo()
  try {
    zotodoInstance.init(); // Call the refactored init
  } catch (e) {
    const msg = `Zotodo: init failed: ${e && (e.stack || e.message || String(e))}`
    Zotero.logError(msg)
    Zotero.debug(msg)
  }
  ;(Zotero as any).Zotodo = zotodoInstance // Make instance globally available

  // Add main window listeners
  try {
    Zotero.getMainWindows().forEach(win => onMainWindowLoad({ window: win }))
  } catch (e) {
    const msg = `Zotodo: error in onMainWindowLoad during startup: ${e && (e.stack || e.message || String(e))}`
    Zotero.logError(msg)
    Zotero.debug(msg)
  }
  // Do not register a 'window' notifier in Zotero 8; bootstrap handles window/menu hooks.
  // Try to register a Preferences pane in Zotero 7/8 unified settings
  try {
    const PP = (Zotero as any).PreferencePanes || (Zotero as any).Preferences || null
    if (PP && typeof PP.register === 'function') {
      try {
        PP.register('zotodo', {
          label: 'Zotodo',
          // Register a legacy XUL prefpane document for unified preferences
          pane: 'chrome://zotodo/content/prefs-pane.xhtml',
          image: null,
          onLoad: (_doc: any, _win: any) => {
            try {
              if ((Zotero as any).Zotodo?.Options?.updatePreferenceWindow) {
                (Zotero as any).Zotodo.Options.updatePreferenceWindow('init-all')
              }
            } catch (_e) { /* ignore */ }
          },
          onSave: (_doc: any, _win: any) => {
            // No-op: XUL bindings write prefs automatically
          },
        })
        Zotero.debug('Zotodo: Preference pane registered with Zotero.PreferencePanes')
      } catch (eReg) {
        Zotero.debug('Zotodo: Preference pane registration failed: ' + (eReg && (eReg.message || String(eReg))))
      }
    } else {
      Zotero.debug('Zotodo: PreferencePanes API not available; keeping Tools menu fallback')
    }
  } catch (_e) { /* ignore */ }

  Zotero.debug('Zotodo: startup complete.')
}

export function shutdown(reason: unknown): void {
  Zotero.debug(`Zotodo: shutdown, reason: ${String(reason)}`)

  Zotero.Notifier.unregisterObserver('Zotodo-window-observer') // Use the unique name

  // Call onMainWindowUnload for all open main windows
  Zotero.getMainWindows().forEach(win => onMainWindowUnload({ window: win }))

  if (zotodoInstance && zotodoInstance.notifierID) {
    Zotero.Notifier.unregisterObserver(zotodoInstance.notifierID)
  }

  if (chromeHandle) {
    chromeHandle.destruct()
    chromeHandle = null
  }

  if ((Zotero ).Zotodo) {
    (Zotero ).Zotodo = null
  }
  zotodoInstance = null
  Zotero.debug('Zotodo: shutdown complete.')
}

export function install(reason: unknown): void {
  Zotero.debug(`Zotodo: install, reason: ${  String(reason)}`)
}

export function uninstall(reason: unknown): void {
  Zotero.debug(`Zotodo: uninstall, reason: ${  String(reason)}`)
}

function onMainWindowLoad({ window }: { window: any }) {
  Zotero.debug(`Zotodo: onMainWindowLoad for window ID ${window.document.documentElement.id}`)
  const doc = window.document

  // Add 'Make Task' to item context menu
  const itemMenuItem = (doc.createXULElement ? doc.createXULElement('menuitem') : doc.createElement('menuitem'))
  itemMenuItem.id = 'zotodo-itemmenu-make-task'
  itemMenuItem.setAttribute('label', 'Create Todoist task') // Using literal string
  itemMenuItem.addEventListener('command', () => {
    // Ensure zotodoInstance and its methods are available
    if (zotodoInstance && typeof zotodoInstance.makeTaskForSelectedItems === 'function') {
      zotodoInstance.makeTaskForSelectedItems()
    }
    else {
      Zotero.debug('Zotodo: zotodoInstance or makeTaskForSelectedItems not available.')
    }
  })

  const zoteroItemMenu = doc.getElementById('zotero-itemmenu')
  if (zoteroItemMenu) {
    let sep = doc.getElementById('id-zotodo-separator')
    if (!sep) {
      sep = (doc.createXULElement ? doc.createXULElement('menuseparator') : doc.createElement('menuseparator'))
      sep.id = 'id-zotodo-separator'
      zoteroItemMenu.appendChild(sep)
    }
    zoteroItemMenu.appendChild(itemMenuItem)
  }
  else {
    Zotero.debug('Zotodo: zotero-itemmenu not found.')
  }

  // Add 'Zotodo Options' to Tools menu
  const toolsMenuItem = doc.createXULElement('menuitem')
  toolsMenuItem.id = 'zotodo-toolsmenu-options'
  toolsMenuItem.setAttribute('label', 'Zotodo Preferences') // Using literal string
  toolsMenuItem.addEventListener('command', () => {
    if (zotodoInstance && typeof zotodoInstance.openPreferenceWindow === 'function') {
      zotodoInstance.openPreferenceWindow()
    }
    else {
      Zotero.debug('Zotodo: zotodoInstance or openPreferenceWindow not available.')
    }
  })

  // Try multiple known Tools menu IDs across Zotero versions
  const toolsMenu = doc.getElementById('menu_ToolsPopup')
    || doc.getElementById('menu_Tools')?.querySelector('menupopup')
    || doc.getElementById('tools-menu')
    || doc.getElementById('zotero-tools-menu')
  if (toolsMenu) {
    toolsMenu.appendChild(toolsMenuItem)
  }
  else {
    Zotero.debug('Zotodo: Tools menu popup not found (tried menu_ToolsPopup, menu_Tools>menupopup, tools-menu, zotero-tools-menu).')
  }

  zotodoInstance?.onWindowLoad(window)
}

function onMainWindowUnload({ window }: { window: any }) {
  Zotero.debug(`Zotodo: onMainWindowUnload for window ID ${window.document.documentElement.id}`)
  const doc = window.document

  // Remove 'Make Task' menu item and its separator
  doc.getElementById('zotodo-itemmenu-make-task')?.remove()
  doc.getElementById('id-zotodo-separator')?.remove()

  // Remove 'Zotodo Options' menu item
  doc.getElementById('zotodo-toolsmenu-options')?.remove()

  zotodoInstance?.onWindowUnload(window)
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

// Expose lifecycle functions on the global object so bootstrap can find them even when bundled as an IIFE
try {
  ;(globalThis as any).startup = startup
  ;(globalThis as any).shutdown = shutdown
  ;(globalThis as any).install = install
  ;(globalThis as any).uninstall = uninstall
  ;(globalThis as any).ZotodoEntrypoints = { startup, shutdown, install, uninstall }
} catch (_e) { /* ignore */ }

try { if (typeof Zotero !== 'undefined' && Zotero && typeof Zotero.debug === 'function') Zotero.debug('Zotodo: zotodo.ts loaded') } catch (_e) { /* ignore */ }

// Early evaluation log + global unhandled-rejection diagnostic
try {
  // Zotero may not be available super-early; guard access for logging
  if (typeof Zotero !== 'undefined' && Zotero && typeof Zotero.debug === 'function') {
    Zotero.debug('Zotodo: content script evaluated')
  }

  // Also capture unhandled rejections as early as possible with a fallback reporter
  if (typeof (globalThis).addEventListener === 'function') {
    (globalThis).addEventListener('unhandledrejection', (event) => {
      try {
        const r = event && event.reason
        const txt = 'Zotodo: Unhandled promise rejection (early handler): ' + (r && (r.stack || r.message || String(r)))
        if (typeof Zotero !== 'undefined' && Zotero && typeof Zotero.logError === 'function') Zotero.logError(txt)
        try { Components.utils.reportError(txt) } catch (_e2) {}
      }
      catch (_e1) {}
    })
  }
} catch (_e) { /* ignore */ }

// Bootstrap loader for Zotero (legacy) add-on to forward lifecycle calls to content/zotodo.js
/* global ChromeUtils, Cc, Ci */

var scope = {}
var rootURI = null
var windowOpenObserver = null
var chromeRegistered = false

function log(msg) {
  try { if (typeof console !== 'undefined' && console && console.log) console.log(String(msg)) } catch (_e2) {}
  try {
    var cs = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService)
    cs.logStringMessage(String(msg))
  } catch (_e3) {}
}

function ensureContentStartedForWindow(win) {
  try {
    if (!win || !win.Zotero) return
    if (win.Zotero && win.Zotero.Zotodo) return // already started
    var loader = Cc['@mozilla.org/moz/jssubscript-loader;1'].getService(Ci.mozIJSSubScriptLoader)
    var loaded = false
    try {
      if (rootURI) {
        loader.loadSubScript(rootURI + 'content/zotodo.js', win, 'UTF-8')
        loaded = true
        log('Zotodo bootstrap: loaded content via rootURI into window context: ' + rootURI + 'content/zotodo.js')
      }
    } catch (e1) {
      log('Zotodo bootstrap: failed to load content via rootURI: ' + e1)
      try {
        // Fallback to chrome URL if chrome.manifest registered it
        loader.loadSubScript('chrome://zotodo/content/zotodo.js', win, 'UTF-8')
        loaded = true
        log('Zotodo bootstrap: loaded content via chrome:// into window context')
      } catch (e2) {
        log('Zotodo bootstrap: failed to load content via chrome:// URL: ' + e2)
      }
    }

    if (!loaded) return

    try {
      var startupFn = null
      if (win.ZotodoEntrypoints && typeof win.ZotodoEntrypoints.startup === 'function') startupFn = win.ZotodoEntrypoints.startup
      else if (typeof win.startup === 'function') startupFn = win.startup
      if (startupFn) {
        startupFn({ version: '', rootURI: (typeof rootURI === 'string' ? rootURI : '') }, 'bootstrap-lazy')
        log('Zotodo bootstrap: invoked content startup in window')
      }
      else {
        log('Zotodo bootstrap: no startup function found on window after load; keys: ' + Object.keys(win).filter(k => /Zotodo/i.test(k)).join(', '))
      }
    } catch (e3) {
      log('Zotodo bootstrap: error calling content startup in window: ' + e3)
    }
  }
  catch (err) {
    log('Zotodo bootstrap: ensureContentStartedForWindow error: ' + err)
  }
}

function addMenus(win) {
  try {
    var doc = win.document
    if (!doc || !doc.getElementById) return

    // Item context menu
    var itemMenu = doc.getElementById('zotero-itemmenu')
    if (itemMenu && !doc.getElementById('zotodo-itemmenu-make-task')) {
      var sep = doc.getElementById('id-zotodo-separator')
      if (!sep) {
        sep = (doc.createXULElement ? doc.createXULElement('menuseparator') : doc.createElement('menuseparator'))
        sep.id = 'id-zotodo-separator'
        itemMenu.appendChild(sep)
      }
      var item = (doc.createXULElement ? doc.createXULElement('menuitem') : doc.createElement('menuitem'))
      item.id = 'zotodo-itemmenu-make-task'
      item.setAttribute('label', 'Create Todoist task (bootstrap)')
      item.addEventListener('command', function () {
        try {
          if (win && win.Zotero && win.Zotero.Zotodo && typeof win.Zotero.Zotodo.makeTaskForSelectedItems === 'function') {
            win.Zotero.Zotodo.makeTaskForSelectedItems()
            return
          }
          ensureContentStartedForWindow(win)
          if (win && win.Zotero && win.Zotero.Zotodo && typeof win.Zotero.Zotodo.makeTaskForSelectedItems === 'function') {
            win.Zotero.Zotodo.makeTaskForSelectedItems()
          }
          else {
            win.alert('Zotodo: content not initialized; check Browser Console for errors')
          }
        } catch (e) { log('Zotodo bootstrap: command error: ' + e + '\n') }
      })
      itemMenu.appendChild(item)
    }

    // Tools menu
    var toolsPopup = doc.getElementById('menu_ToolsPopup') || (doc.getElementById('menu_Tools') && doc.getElementById('menu_Tools').querySelector('menupopup')) || doc.getElementById('tools-menu') || doc.getElementById('zotero-tools-menu')
    if (toolsPopup && !doc.getElementById('zotodo-toolsmenu-options')) {
      var toolsItem = (doc.createXULElement ? doc.createXULElement('menuitem') : doc.createElement('menuitem'))
      toolsItem.id = 'zotodo-toolsmenu-options'
      toolsItem.setAttribute('label', 'Zotodo Preferences (bootstrap)')
      toolsItem.addEventListener('command', function () {
        try {
          // Try to open preferences via content code if available
          if (win && win.Zotero && win.Zotero.Zotodo && typeof win.Zotero.Zotodo.openPreferenceWindow === 'function') {
            win.Zotero.Zotodo.openPreferenceWindow()
            return
          }
          ensureContentStartedForWindow(win)
          if (win && win.Zotero && win.Zotero.Zotodo && typeof win.Zotero.Zotodo.openPreferenceWindow === 'function') {
            win.Zotero.Zotodo.openPreferenceWindow()
            return
          }
          // Fallback: offer simple prompts to set core preferences so the add-on can function
          try {
            var ps = Cc['@mozilla.org/prompter;1'].getService(Ci.nsIPromptService)
            // 1) Token
            var tokenObj = { value: (win && win.Zotero && win.Zotero.Prefs ? win.Zotero.Prefs.get('extensions.zotodo.todoist_token', '') : '') }
            var ok = ps.prompt(win, 'Zotodo', 'Enter your Todoist API token:', tokenObj, null, {})
            if (ok && win && win.Zotero && win.Zotero.Prefs) {
              // Pass 'true' to write to the default branch so the value persists and is globally readable
              try { win.Zotero.Prefs.set('extensions.zotodo.todoist_token', tokenObj.value, true) } catch (_eSet) { win.Zotero.Prefs.set('extensions.zotodo.todoist_token', tokenObj.value) }
              // 2) Project name
              var currentProject = (function(){ try { return win.Zotero.Prefs.get('extensions.zotodo.project', true) } catch (_e) { try { return win.Zotero.Prefs.get('extensions.zotodo.project') } catch (_e2) { return '' } } })()
              if (!currentProject || String(currentProject).trim() === '') currentProject = 'Reading Queue'
              var projectObj = { value: String(currentProject) }
              ps.prompt(win, 'Zotodo', 'Enter the Todoist project to use (will be created if missing):', projectObj, null, {})
              try { win.Zotero.Prefs.set('extensions.zotodo.project', projectObj.value, true) } catch (_eSet2) { win.Zotero.Prefs.set('extensions.zotodo.project', projectObj.value) }
              // 3) Optional section
              var currentSection = (function(){ try { return win.Zotero.Prefs.get('extensions.zotodo.section', true) } catch (_e3) { try { return win.Zotero.Prefs.get('extensions.zotodo.section') } catch (_e4) { return '' } } })()
              var sectionObj = { value: String(currentSection || '') }
              ps.prompt(win, 'Zotodo', 'Enter a section within the project (optional):', sectionObj, null, {})
              try { win.Zotero.Prefs.set('extensions.zotodo.section', sectionObj.value, true) } catch (_eSet3) { win.Zotero.Prefs.set('extensions.zotodo.section', sectionObj.value) }
              win.alert('Zotodo: Preferences saved. You can change these later when the full preferences UI is available.')
              return
            }
          } catch (ePrompt) {
            log('Zotodo bootstrap: prompt fallback failed: ' + ePrompt)
          }
          // As a last resort, try opening options.xhtml directly from the XPI (may fail without chrome registration)
          if (typeof rootURI === 'string' && rootURI) {
            try {
              win.openDialog(rootURI + 'content/options.xhtml', 'zotodo-options', 'chrome,titlebar,toolbar,centerscreen,resizable')
              return
            } catch (eOpen) {
              log('Zotodo bootstrap: direct openDialog fallback failed: ' + eOpen)
            }
          }
          win.alert('Zotodo: preferences UI not available; content not initialized')
        } catch (e) { log('Zotodo bootstrap: prefs error: ' + e + '\n') }
      })
      toolsPopup.appendChild(toolsItem)
    }
  }
  catch (err) {
    log('Zotodo bootstrap: addMenus error: ' + err + '\n')
  }
}

function removeMenus(win) {
  try {
    var doc = win.document
    if (!doc) return
    var ids = ['zotodo-itemmenu-make-task', 'id-zotodo-separator', 'zotodo-toolsmenu-options']
    ids.forEach(function (id) {
      var el = doc.getElementById(id)
      if (el && el.parentNode) el.parentNode.removeChild(el)
    })
  }
  catch (err) {
    log('Zotodo bootstrap: removeMenus error: ' + err + '\n')
  }
}

function hookExistingWindows() {
  try {
    var wm = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator)
    var e = wm.getEnumerator(null)
    while (e.hasMoreElements()) {
      var win = e.getNext()
      try { if (win && win.document && win.document.getElementById('zotero-itemmenu')) addMenus(win) } catch (_e) {}
    }
  }
  catch (err) {
    log('Zotodo bootstrap: hookExistingWindows error: ' + err + '\n')
  }
}

function observeWindowOpens() {
  try {
    var ww = Cc['@mozilla.org/embedcomp/window-watcher;1'].getService(Ci.nsIWindowWatcher)
    windowOpenObserver = { observe: function (subject, topic) {
      try {
        if (topic !== 'domwindowopened') return
        var win = subject
        win.addEventListener('load', function onLoad() {
          try {
            win.removeEventListener('load', onLoad, false)
            if (win && win.document && win.document.getElementById('zotero-itemmenu')) addMenus(win)
          } catch (e) { log('Zotodo bootstrap: domwindowopened load handler error: ' + e + '\n') }
        }, false)
      } catch (e) { log('Zotodo bootstrap: window open observer error: ' + e + '\n') }
    }}
    ww.registerNotification(windowOpenObserver)
  }
  catch (err) {
    log('Zotodo bootstrap: observeWindowOpens error: ' + err + '\n')
  }
}

function unobserveWindowOpens() {
  try {
    if (!windowOpenObserver) return
    var ww = Cc['@mozilla.org/embedcomp/window-watcher;1'].getService(Ci.nsIWindowWatcher)
    ww.unregisterNotification(windowOpenObserver)
    windowOpenObserver = null
  }
  catch (err) {
    log('Zotodo bootstrap: unobserveWindowOpens error: ' + err + '\n')
  }
}

function startup(data, reason) {
  try {
    log('Zotodo bootstrap: startup starting')
    if (!data || !data.resourceURI) {
      log('Zotodo bootstrap: data.resourceURI unavailable; proceeding with bootstrap-only UI injection')
      try {
        // Derive rootURI from this script location (jar:file:///...xpi!/bootstrap.js)
        var selfURI = (Components && Components.stack && Components.stack.filename) ? Components.stack.filename : null
        if (selfURI && /bootstrap\.js/.test(selfURI)) {
          rootURI = selfURI.replace(/bootstrap\.js.*$/, '')
          log('Zotodo bootstrap: derived rootURI from stack: ' + rootURI)
        }
      } catch (_e) {}
      // Do not attempt dynamic chrome registration; rely on chrome.manifest packaged in the XPI
      hookExistingWindows()
      observeWindowOpens()
      return
    }
    rootURI = data.resourceURI.spec // e.g., jar:file:///.../zotodo.xpi!/
    // Use the subscript loader via XPCOM to avoid importing Services.sys.mjs
    var loader = Cc['@mozilla.org/moz/jssubscript-loader;1'].getService(Ci.mozIJSSubScriptLoader)
    log('Zotodo bootstrap: attempting to load content/zotodo.js (scoped)')
    loader.loadSubScript(rootURI + 'content/zotodo.js', scope, 'UTF-8')
    log('Zotodo bootstrap: loaded content/zotodo.js (scoped)')
    var entry = (scope && typeof scope.startup === 'function') ? scope : (scope.ZotodoBundle || null)

    // Fallback: try loading into the bootstrap global if not found on the scoped load
    if (!(entry && typeof entry.startup === 'function')) {
      try {
        loader.loadSubScript(rootURI + 'content/zotodo.js') // load into bootstrap global
      }
      catch (e) {
        log('Zotodo bootstrap: fallback loadSubScript failed: ' + e + '\n')
      }
      if (typeof ZotodoEntrypoints !== 'undefined' && ZotodoEntrypoints && typeof ZotodoEntrypoints.startup === 'function') entry = ZotodoEntrypoints
      else if (typeof ZotodoBundle !== 'undefined' && ZotodoBundle && typeof ZotodoBundle.startup === 'function') entry = ZotodoBundle
    }

    if (entry && typeof entry.startup === 'function') {
      entry.startup({ version: data.version, rootURI }, reason)
    }
    else {
      log('Zotodo bootstrap: startup entry not found on loaded script.\n')
      if (scope && scope.Zotero) scope.Zotero.logError('Zotodo: bootstrap could not find startup function on loaded script')
    }

    // Always install minimal menus from bootstrap so there is visible feedback
    hookExistingWindows()
    observeWindowOpens()
  }
  catch (err) {
    log('Zotodo bootstrap startup error: ' + err + '\n')
  }
}

function shutdown(data, reason) {
  try {
    if (scope && typeof scope.shutdown === 'function') {
      scope.shutdown(reason)
    }
  }
  catch (err) {
    log('Zotodo bootstrap shutdown error: ' + err + '\n')
  }
  finally {
    try {
      // Remove menus from all open windows
      var wm = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator)
      var e = wm.getEnumerator(null)
      while (e.hasMoreElements()) {
        var win = e.getNext()
        try { removeMenus(win) } catch (_e) {}
      }
    } catch (_e) {}
    unobserveWindowOpens()
    scope = {}
    rootURI = null
  }
}

function install(data, reason) {
  try {
    if (scope && typeof scope.install === 'function') {
      scope.install(reason)
    }
  }
  catch (err) {
    log('Zotodo bootstrap install error: ' + err + '\n')
  }
}

function uninstall(data, reason) {
  try {
    if (scope && typeof scope.uninstall === 'function') {
      scope.uninstall(reason)
    }
  }
  catch (err) {
    log('Zotodo bootstrap uninstall error: ' + err + '\n')
  }
}

var EXPORTED_SYMBOLS = [ 'startup', 'shutdown', 'install', 'uninstall' ]

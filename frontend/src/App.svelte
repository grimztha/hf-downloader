<script lang="ts">
  import { onMount } from 'svelte'
  import {
    EventsOn,
    WindowMinimise,
    WindowToggleMaximise,
    WindowIsMaximised,
    Quit
  } from '../wailsjs/runtime/runtime'
  import { ParseAndInspect, SelectDirectoryDialog, GetAppVersion } from '../wailsjs/go/main/App'
  import type { InspectResponse, FileNode, DownloadItem } from './lib/types'
  import { queueStore, fetchQueue, addQueueItems, handleProgressUpdate } from './lib/stores/queue'
  import { bookmarksStore, fetchBookmarks } from './lib/stores/bookmarks'
  import { settingsStore, fetchSettings } from './lib/stores/settings'

  import URLInputBar from './lib/components/URLInputBar.svelte'
  import RepoInspector from './lib/components/RepoInspector.svelte'
  import FileRouterModal from './lib/components/FileRouterModal.svelte'
  import FolderBookmarks from './lib/components/FolderBookmarks.svelte'
  import DownloadQueue from './lib/components/DownloadQueue.svelte'
  import TokenHelperModal from './lib/components/TokenHelperModal.svelte'
  import SettingsTab from './lib/components/SettingsTab.svelte'
  import appLogo from './assets/images/logo.png'

  import {
    DownloadCloud,
    FolderTree,
    ListOrdered,
    Bookmark,
    Settings as SettingsIcon,
    AlertCircle,
    Zap
  } from 'lucide-svelte'
  import { initTheme } from './lib/stores/theme'

  let activeTab: 'inspector' | 'queue' | 'bookmarks' | 'settings' = 'inspector'
  let appVersion: string = 'v1.1.1'
  let loadingInspection: boolean = false
  let inspectResult: InspectResponse | null = null
  let inspectError: string = ''
  let isGatedError: boolean = false
  let isMaximised: boolean = false

  // Pre-calculated default destinations mapped by file path
  let defaultDestinations: Record<string, string> = {}

  // Modals
  let showTokenModal: boolean = false
  let showRouterModal: boolean = false
  let filesToRoute: { file: FileNode; dest: string }[] = []

  // Metrics
  $: activeDownloads = $queueStore.filter(i => i.status === 'downloading')
  $: totalActiveSpeedBps = activeDownloads.reduce((acc, curr) => acc + (curr.speedBps || 0), 0)
  $: formattedTotalSpeed = totalActiveSpeedBps > 1024 * 1024
    ? `${(totalActiveSpeedBps / (1024 * 1024)).toFixed(2)} MB/s`
    : totalActiveSpeedBps > 1024
    ? `${(totalActiveSpeedBps / 1024).toFixed(1)} KB/s`
    : ''

  async function handleMinimise() {
    WindowMinimise()
  }

  async function handleToggleMaximise() {
    WindowToggleMaximise()
    setTimeout(async () => {
      try {
        isMaximised = await WindowIsMaximised()
      } catch {}
    }, 60)
  }

  function handleClose() {
    Quit()
  }

  function handleTitlebarDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (target.closest('button, nav, input, a, [data-no-drag]')) return
    handleToggleMaximise()
  }

  onMount(() => {
    initTheme()
    // Initial data load
    GetAppVersion().then(v => {
      if (v) appVersion = `v${v.replace(/^v/, '')}`
    }).catch(() => {})
    fetchSettings()
    fetchBookmarks()
    fetchQueue()

    const updateMaxState = async () => {
      try {
        isMaximised = await WindowIsMaximised()
      } catch {}
    }
    window.addEventListener('resize', updateMaxState)
    updateMaxState()

    // Listen to live background progress events from Go backend
    const unsub = EventsOn('download:progress', (data: any) => {
      handleProgressUpdate(data as DownloadItem)
    })

    return () => {
      if (unsub) unsub()
      window.removeEventListener('resize', updateMaxState)
    }
  })

  // Determine pre-routed folder based on filename rules
  function matchRule(filePath: string): string {
    const s = $settingsStore
    if (!s) return ''
    const lower = filePath.toLowerCase()
    for (const rule of s.routingRules || []) {
      const p = rule.pattern.toLowerCase().replace(/\*/g, '')
      if (p && lower.includes(p)) {
        return rule.targetDir
      }
    }
    return s.defaultDownloadDir || ''
  }

  async function handleInspect(e: CustomEvent<string>) {
    const input = e.detail
    loadingInspection = true
    inspectError = ''
    isGatedError = false
    inspectResult = null

    try {
      const res = await ParseAndInspect(input)
      inspectResult = res

      // Calculate pre-routed folders for each discovered file
      const destMap: Record<string, string> = {}
      for (const f of res.files || []) {
        destMap[f.path] = matchRule(f.path)
      }
      defaultDestinations = destMap
      activeTab = 'inspector'
    } catch (err: any) {
      console.error('Inspect error:', err)
      const errStr = String(err)
      inspectError = errStr
      if (errStr.includes('gated') || errStr.includes('401') || errStr.includes('403') || errStr.includes('authorization')) {
        isGatedError = true
      }
    } finally {
      loadingInspection = false
    }
  }

  async function handleStage(e: CustomEvent<{ selectedFiles: { file: FileNode; dest: string }[]; autoStart: boolean }>) {
    const { selectedFiles, autoStart } = e.detail
    if (!selectedFiles || selectedFiles.length === 0 || !inspectResult?.target) return

    const items: DownloadItem[] = selectedFiles.map(({ file, dest }) => {
      const parts = file.path.split('/')
      const finalFilename = parts[parts.length - 1] || 'model.safetensors'

      return {
        id: '',
        repoId: inspectResult!.target!.repoId,
        revision: inspectResult!.target!.revision,
        remotePath: file.path,
        destinationDir: dest || defaultDestinations[file.path] || $settingsStore?.defaultDownloadDir || '',
        finalFilename: finalFilename,
        size: file.size || 0,
        expectedSha256: file.sha256 || file.lfs?.oid || file.lfs?.sha256 || '',
        status: 'staged',
        autoStart: autoStart,
        downloadedBytes: 0,
        progress: 0,
        speedBps: 0,
        speedFormatted: '',
        etaSeconds: 0,
        createdAt: 0,
      } as DownloadItem
    })

    await addQueueItems(items, autoStart)
    activeTab = 'queue'
  }

  function handleOpenRouter(e: CustomEvent<{ selectedFiles: { file: FileNode; dest: string }[] }>) {
    filesToRoute = e.detail.selectedFiles
    showRouterModal = true
  }

  function handleSaveRouter(e: CustomEvent<{ files: { file: FileNode; dest: string }[] }>) {
    const updated = e.detail.files
    const nextMap = { ...defaultDestinations }
    for (const item of updated) {
      nextMap[item.file.path] = item.dest
    }
    defaultDestinations = nextMap
  }

  async function handleChangeSingleDest(e: CustomEvent<{ filePath: string }>) {
    const path = e.detail.filePath
    const current = defaultDestinations[path] || ''
    try {
      const chosen = await SelectDirectoryDialog(current)
      if (chosen) {
        defaultDestinations = { ...defaultDestinations, [path]: chosen }
      }
    } catch (err) {
      console.error(err)
    }
  }
</script>

<div class="min-h-screen bg-dark-900 text-slate-100 flex flex-col font-sans selection:bg-accent-indigo selection:text-white">
  <!-- Unified Modern Window Bar & App Header -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    class="h-12 border-b border-dark-700/80 bg-dark-850/95 backdrop-blur-md px-3.5 flex items-center justify-between sticky top-0 z-30 select-none"
    style="--wails-draggable: drag; -webkit-app-region: drag;"
    on:dblclick={handleTitlebarDblClick}
  >
    <!-- Left: App Identity -->
    <div class="flex items-center gap-2.5 flex-shrink-0 pointer-events-none select-none">
      <img
        src={appLogo}
        alt="HF Downloader Logo"
        class="w-6 h-6 rounded-lg object-contain shadow-sm shadow-indigo-500/20"
      />
      <div class="flex items-center gap-2">
        <span class="text-xs font-bold tracking-tight text-white">HF Downloader</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded font-mono bg-dark-750/70 text-accent-indigo font-bold border border-dark-600/60 leading-none">
          {appVersion}
        </span>
      </div>
    </div>

    <!-- Center Navigation Tabs -->
    <nav
      data-no-drag
      class="flex items-center gap-1 bg-dark-950/70 border border-dark-700/60 p-0.5 rounded-xl shadow-inner mx-4 flex-shrink-0"
      style="--wails-draggable: no-drag; -webkit-app-region: no-drag;"
    >
      <button
        type="button"
        on:click={() => (activeTab = 'inspector')}
        class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all {activeTab === 'inspector' ? 'bg-accent-indigo text-white shadow-sm shadow-indigo-500/25' : 'text-slate-400 hover:text-slate-200'}"
      >
        <FolderTree class="w-3.5 h-3.5" />
        <span>Repo Inspector</span>
      </button>

      <button
        type="button"
        on:click={() => (activeTab = 'queue')}
        class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all relative {activeTab === 'queue' ? 'bg-accent-indigo text-white shadow-sm shadow-indigo-500/25' : 'text-slate-400 hover:text-slate-200'}"
      >
        <ListOrdered class="w-3.5 h-3.5" />
        <span>Queue</span>
        {#if $queueStore.length > 0}
          <span class="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-dark-800 text-accent-cyan border border-dark-700">
            {$queueStore.length}
          </span>
        {/if}
      </button>

      <button
        type="button"
        on:click={() => (activeTab = 'bookmarks')}
        class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all {activeTab === 'bookmarks' ? 'bg-accent-indigo text-white shadow-sm shadow-indigo-500/25' : 'text-slate-400 hover:text-slate-200'}"
      >
        <Bookmark class="w-3.5 h-3.5" />
        <span>Bookmarks</span>
      </button>

      <button
        type="button"
        on:click={() => (activeTab = 'settings')}
        class="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all {activeTab === 'settings' ? 'bg-accent-indigo text-white shadow-sm shadow-indigo-500/25' : 'text-slate-400 hover:text-slate-200'}"
      >
        <SettingsIcon class="w-3.5 h-3.5" />
        <span>Settings</span>
      </button>
    </nav>

    <!-- Right: Live Speed Indicator & Windows Titlebar Controls -->
    <div
      data-no-drag
      class="flex items-center gap-2 h-full -mr-3.5 flex-shrink-0"
      style="--wails-draggable: no-drag; -webkit-app-region: no-drag;"
    >
      {#if formattedTotalSpeed}
        <div class="flex items-center gap-1.5 px-2.5 py-1 mr-1 bg-accent-indigo/10 border border-accent-indigo/30 rounded-full text-xs font-mono text-accent-cyan animate-pulse">
          <Zap class="w-3.5 h-3.5 text-accent-indigo" />
          <span class="font-bold">{formattedTotalSpeed}</span>
          {#if $settingsStore?.speedLimitMBps && $settingsStore.speedLimitMBps > 0}
            <span class="text-[10px] text-slate-400 font-normal">/ {$settingsStore.speedLimitMBps} MB/s</span>
          {/if}
        </div>
      {/if}

      <!-- Custom Windows Window Controls (Minimize, Maximize/Restore, Close) -->
      <div class="flex items-stretch h-full">
        <!-- Minimize -->
        <button
          type="button"
          on:click={handleMinimise}
          class="window-control-btn"
          title="Minimize"
          aria-label="Minimize window"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
            <line x1="2.5" y1="8" x2="13.5" y2="8" stroke-linecap="round" />
          </svg>
        </button>

        <!-- Maximize / Restore -->
        <button
          type="button"
          on:click={handleToggleMaximise}
          class="window-control-btn"
          title={isMaximised ? 'Restore' : 'Maximize'}
          aria-label={isMaximised ? 'Restore window' : 'Maximize window'}
        >
          {#if isMaximised}
            <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="4.5" y="2.5" width="8.5" height="8.5" rx="0.5" />
              <path d="M2.5 5.5v7.5a0.5 0.5 0 0 0 0.5 0.5h7.5" />
            </svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
            </svg>
          {/if}
        </button>

        <!-- Close -->
        <button
          type="button"
          on:click={handleClose}
          class="window-control-btn close-btn"
          title="Close"
          aria-label="Close window"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
            <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke-linecap="round" />
            <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>
  </header>

  <!-- Main Scrollable Body Area -->
  <main class="flex-1 p-6 max-w-7xl w-full mx-auto flex flex-col gap-6">
    <!-- URL Sniffer Bar (Persistent on Inspector view) -->
    {#if activeTab === 'inspector'}
      <URLInputBar
        loading={loadingInspection}
        on:inspect={handleInspect}
        on:openTokenModal={() => (showTokenModal = true)}
      />

      <!-- Gated Repo or Inspect Error Alert -->
      {#if inspectError}
        <div class="p-4 bg-rose-950/20 border border-rose-500/40 rounded-2xl flex items-start justify-between gap-3 text-xs text-rose-300 animate-in fade-in">
          <div class="flex items-start gap-2.5">
            <AlertCircle class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <div>
              <div class="font-bold text-rose-200 mb-0.5">
                {isGatedError ? 'Gated or Private Model Repository' : 'Failed to Inspect Repository'}
              </div>
              <div class="text-slate-300 leading-relaxed">
                {inspectError}
              </div>
            </div>
          </div>

          {#if isGatedError}
            <button
              type="button"
              on:click={() => (showTokenModal = true)}
              class="px-3 py-1.5 rounded-lg bg-accent-indigo hover:bg-indigo-500 text-white font-semibold text-xs flex-shrink-0 transition-colors"
            >
              Configure Token
            </button>
          {/if}
        </div>
      {/if}

      <!-- Discovered Tree Inspector -->
      {#if inspectResult}
        <RepoInspector
          target={inspectResult.target || null}
          files={inspectResult.files || []}
          {defaultDestinations}
          on:stage={handleStage}
          on:openRouter={handleOpenRouter}
          on:changeDest={handleChangeSingleDest}
        />
      {:else if !loadingInspection && !inspectError}
        <div class="py-16 flex flex-col items-center justify-center text-center gap-3 text-slate-500 border border-dashed border-dark-700/80 rounded-2xl bg-dark-850/40">
          <DownloadCloud class="w-12 h-12 text-slate-600 animate-bounce duration-1000" />
          <div class="max-w-md">
            <h3 class="text-sm font-bold text-slate-300">Ready to Sniff Hugging Face Repos</h3>
            <p class="text-xs text-slate-500 mt-1">
              Paste any Hugging Face URL above to automatically inspect model trees, select weights with precision tags, and route files across your local drives.
            </p>
          </div>
        </div>
      {/if}
    {:else if activeTab === 'queue'}
      <DownloadQueue />
    {:else if activeTab === 'bookmarks'}
      <FolderBookmarks />
    {:else if activeTab === 'settings'}
      <SettingsTab />
    {/if}
  </main>

  <!-- Modals -->
  <TokenHelperModal
    show={showTokenModal}
    on:close={() => (showTokenModal = false)}
  />

  <FileRouterModal
    show={showRouterModal}
    targetFiles={filesToRoute}
    on:save={handleSaveRouter}
    on:close={() => (showRouterModal = false)}
  />
</div>

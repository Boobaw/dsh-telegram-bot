window.__ModuleLoader__.load({
  id: 'dsh-telegram-bot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, SettingsSecretField, Switch } = primitives
    const h = React.createElement

    /** Loader row id / settings namespace; the npm package name is dsh-telegram-bot. */
    const NS = 'telegram-bot'
    /** Default credential reference holding the Telegram bot token. */
    const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

    const en = {
      nav: 'Telegram',
      title: 'Telegram bot',
      description: 'Configure the bot token and who may talk to the bot.',
      botToken: 'Bot token',
      tokenValue: 'Token value',
      tokenHint: 'Create a bot with @BotFather and paste its token. The token is stored in the credential store, never in the settings file.',
      tokenConfigured: 'A token is configured',
      tokenMissing: 'No token is configured yet',
      tokenReadOnly: 'The token is supplied by the environment or the store is read-only, so it cannot be changed here.',
      removeToken: 'Remove token',
      removeTokenConfirm: 'Remove the stored bot token?',
      tokenRemoved: 'The stored token was removed.',
      access: 'Access',
      botLanguage: 'Bot language',
      botLanguageHint: 'Language of all Telegram messages; English is the default.',
      enabled: 'Enable bot',
      enabledHint: 'The runtime polls Telegram while this profile is running.',
      showThinking: 'Show model thinking',
      showThinkingHint: 'Send reasoning deltas as a separate Thinking message in the session topic.',
      showToolCalls: 'Show tool calls',
      showToolCallsHint: 'Send tool names and arguments as they are called.',
      allowedUsers: 'Allowed users',
      allowedUsersHint: 'Telegram user ids or @usernames allowed to talk to the bot. Empty means nobody.',
      allowedChats: 'Allowed chats',
      allowedChatsHint: 'Telegram chat ids or @channelnames the bot may answer in. Empty means no group or channel chats.',
      add: 'Add',
      remove: 'Remove',
      emptyUsers: 'No users added yet.',
      emptyChats: 'No chats added yet.',
      placeholderUsers: '123456789 or @username',
      placeholderChats: '-1001234567890 or @channel',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved.',
      restart: 'Restart bot',
      restartRequested: 'Restart requested. Check Telegram or the DSH log.',
      restartFailed: 'The Host did not accept the restart request.',
      bundleSummary: 'Telegram bot',
      pluginPageDescription: 'This plugin must be configured in Settings → Telegram: bot token, access lists.',
      pluginPageLocation: 'Open Settings → Telegram to configure this plugin.',
      pluginConfigFiles: 'Manual configuration files:',
      pluginConfigSettings: 'plugin settings (cordis.patch.yml)',
      pluginConfigToken: 'bot token (credential store)',
      pluginConfigEnv: 'token fallback for headless deployments',
      hostNeedsRestart: 'The Telegram runtime is not loaded in this DSH process yet. Restart dsh web once; after that this page can restart the bot.',
      discard: 'Discard',
      saveFailed: 'The Host did not accept these values.',
      invalidToken: 'Enter a token without spaces.',
      loading: 'Loading…',
      loadingSettings: 'Loading settings…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
    }

    const ru = {
      nav: 'Telegram',
      title: 'Telegram-бот',
      description: 'Токен бота и список тех, кому можно с ним общаться.',
      botToken: 'Токен бота',
      tokenValue: 'Значение токена',
      tokenHint: 'Создайте бота через @BotFather и вставьте токен. Он хранится в credential store, а не в файле настроек.',
      tokenConfigured: 'Токен настроен',
      tokenMissing: 'Токен ещё не задан',
      tokenReadOnly: 'Токен задан через окружение или хранилище доступно только для чтения, поэтому здесь его нельзя изменить.',
      removeToken: 'Удалить токен',
      removeTokenConfirm: 'Удалить сохранённый токен бота?',
      tokenRemoved: 'Сохранённый токен удалён.',
      access: 'Доступ',
      botLanguage: 'Язык бота',
      botLanguageHint: 'Язык сообщений в Telegram; по умолчанию английский.',
      enabled: 'Включить бота',
      enabledHint: 'Runtime опрашивает Telegram, пока запущен этот профиль.',
      showThinking: 'Показывать think модели',
      showThinkingHint: 'Отправлять reasoning отдельным сообщением «Thinking» в топик сессии.',
      showToolCalls: 'Показывать tool calls',
      showToolCallsHint: 'Отправлять имя инструмента и аргументы по мере вызова.',
      allowedUsers: 'Разрешённые пользователи',
      allowedUsersHint: 'Telegram user id или @username, кому можно писать боту. Пустой список — никому.',
      allowedChats: 'Разрешённые чаты',
      allowedChatsHint: 'Telegram chat id или @channelname, где бот может отвечать. Пустой список — только личные сообщения.',
      add: 'Добавить',
      remove: 'Удалить',
      emptyUsers: 'Пользователи пока не добавлены.',
      emptyChats: 'Чаты пока не добавлены.',
      placeholderUsers: '123456789 или @username',
      placeholderChats: '-1001234567890 или @channel',
      save: 'Сохранить',
      saving: 'Сохранение…',
      saved: 'Сохранено.',
      restart: 'Перезапустить бота',
      restartRequested: 'Запрошен перезапуск. Проверьте Telegram или лог DSH.',
      restartFailed: 'Host не принял запрос на перезапуск.',
      bundleSummary: 'Telegram-бот',
      pluginPageDescription: 'Плагин настраивается в Settings → Telegram: токен бота, списки доступа.',
      pluginConfigFiles: 'Файлы для ручной настройки:',
      pluginConfigSettings: 'настройки плагина (cordis.patch.yml)',
      pluginConfigToken: 'токен бота (credential store)',
      pluginConfigEnv: 'fallback токена для headless',
      pluginPageLocation: 'Открой Settings → Telegram, чтобы настроить плагин.',
      hostNeedsRestart: 'Telegram runtime ещё не загружен в этот процесс DSH. Перезапусти dsh web один раз; после этого кнопка рестарта заработает.',
      discard: 'Отменить',
      saveFailed: 'Host не принял эти значения.',
      invalidToken: 'Введите токен без пробелов.',
      loading: 'Загрузка…',
      loadingSettings: 'Загрузка настроек…',
      unavailable: 'Плагин не загружен, поэтому настройки сейчас недоступны.',
      readOnly: 'Этот deployment хранит настройки только для чтения.',
    }

    const CSS = `
      .dtb-page{display:flex;flex-direction:column;gap:16px;max-width:680px;padding:4px 0 32px;color:var(--dsw-alias-label-primary)}
      .dtb-header{display:flex;flex-direction:column;gap:6px}
      .dtb-title{margin:0;font-size:20px;font-weight:600;line-height:28px}
      .dtb-description{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dtb-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
      .dtb-cardTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}
      .dtb-badge{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:22px;white-space:nowrap}
      .dtb-badgeOk{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
      .dtb-field{display:flex;flex-direction:column;gap:6px}
      .dtb-label{font-size:13px;font-weight:500;line-height:20px}
      .dtb-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dtb-toggleRow{display:flex;align-items:center;justify-content:space-between;gap:20px}
      .dtb-select{min-width:130px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#444);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);color-scheme:dark}
      .dtb-select option{background:#1f1f1f;color:#f2f2f2}
      .dtb-select option:checked{background:#2b5278;color:#fff}
      .dtb-toggleCopy{display:flex;flex-direction:column;gap:4px;min-width:0}
      .dtb-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:26px}
      .dtb-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:26px;padding:0 4px 0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code);font-size:12px;line-height:24px}
      .dtb-chipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dtb-chipRemove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;cursor:pointer}
      .dtb-chipRemove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dtb-chipRemove:disabled{cursor:default;opacity:.5}
      .dtb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:26px}
      .dtb-addRow{display:flex;align-items:center;gap:8px}
      .dtb-input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
      .dtb-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dtb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
      .dtb-input:disabled{opacity:.6;cursor:not-allowed}
      .dtb-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:2px}
      .dtb-footerActions{display:flex;align-items:center;gap:8px}
      .dtb-message{min-height:20px;font-size:12px;line-height:20px}
      .dtb-messageOk{color:var(--dsw-alias-state-success-primary)}
      .dtb-messageError{color:var(--dsw-alias-state-error-primary)}
      .dtb-plugin{display:flex;flex-direction:column;gap:16px;padding-top:4px}
      .dtb-notice{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dtb-loading{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:13px}
      @media (max-width:560px){.dtb-toggleRow{align-items:flex-start;flex-direction:column;gap:8px}.dtb-footer{align-items:stretch;flex-direction:column}.dtb-footerActions{justify-content:flex-end}}
    `

    /**
     * Keep only non-empty strings from a Host section value.
     * @param value - a section field that may be absent or malformed in a hand-edited patch.
     * @returns a trimmed copy.
     */
    function stringArray(value) {
      if (!Array.isArray(value)) return []
      return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    }

    /**
     * Read the credential reference from a live settings value.
     * @param value - settings section value.
     * @returns the configured reference or the default.
     */
    function tokenRefOfValue(value) {
      const ref = value?.tokenRef
      return typeof ref === 'string' && ref.trim().length > 0 ? ref.trim() : DEFAULT_TOKEN_REF
    }

    /**
     * Compare two access lists as ordered lists.
     * @param left - first list.
     * @param right - second list.
     * @returns whether both hold the same entries in the same order.
     */
    function sameList(left, right) {
      return left.length === right.length && left.every((item, index) => item === right[index])
    }

    /**
     * Split pasted text into access entries and append the new ones.
     * @param current - existing entries.
     * @param raw - one or more ids/usernames separated by whitespace, commas, or semicolons.
     * @returns a new list without case-insensitive duplicates.
     */
    function appendEntries(current, raw) {
      const next = [...current]
      for (const part of raw.split(/[\s,;]+/u)) {
        const value = part.trim()
        if (value.length === 0) continue
        const key = value.toLowerCase()
        if (!next.some((item) => item.toLowerCase() === key)) next.push(value)
      }
      return next
    }

    /**
     * Read the token's presence and writability without ever receiving its value.
     * @param ctx - client context carrying `remote.credentials`.
     * @returns presence and writability.
     */
    async function readToken(ctx, ref) {
      const response = await ctx.remote.credentials.describe([ref])
      if (!response.ok) throw new Error(response.error.message)
      const view = response.value[ref]
      return {
        configured: view?.configured === true,
        writable: view?.writable !== false,
      }
    }

    /**
     * Write the token through the credential seam and read back its presence.
     * @param ctx - client context carrying `remote.credentials`.
     * @param value - non-empty token literal.
     * @returns presence and writability after the write.
     */
    async function saveToken(ctx, ref, value) {
      const response = await ctx.remote.credentials.set(ref, value)
      if (!response.ok) throw new Error(response.error.message)
      return readToken(ctx, ref)
    }

    /**
     * Remove the stored token; an environment-provided token stays in place.
     * @param ctx - client context carrying `remote.credentials`.
     * @returns presence and writability after the removal.
     */
    async function clearToken(ctx, ref) {
      const response = await ctx.remote.credentials.unset(ref)
      if (!response.ok) throw new Error(response.error.message)
      return readToken(ctx, ref)
    }

    /**
     * Page frame shared by the loading, unavailable, and loaded states.
     * @param props - locale reader and page body.
     * @returns the section shell.
     */
    function PageFrame(props) {
      return h(
        'div',
        { className: 'dtb-page' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'dtb-header' },
          h('h2', { className: 'dtb-title' }, props.t('title')),
          h('p', { className: 'dtb-description' }, props.t('description')),
        ),
        props.children,
      )
    }

    /**
     * Editable list of user ids, usernames, or chat ids.
     * @param props - list value, change handler, labels, and disabled state.
     * @returns chips plus an add row.
     */
    function ListEditor(props) {
      const { t, label, hint, items, onChange, placeholder, emptyLabel, disabled } = props
      const [draft, setDraft] = React.useState('')

      const add = () => {
        const next = appendEntries(items, draft)
        setDraft('')
        if (next.length !== items.length) onChange(next)
      }

      return h(
        'div',
        { className: 'dtb-field' },
        h('span', { className: 'dtb-label' }, label),
        h('p', { className: 'dtb-hint' }, hint),
        h(
          'div',
          { className: 'dtb-chips' },
          items.length === 0
            ? h('span', { className: 'dtb-empty' }, emptyLabel)
            : items.map((item, index) =>
                h(
                  'span',
                  { className: 'dtb-chip', key: `${item}-${index}` },
                  h('span', { className: 'dtb-chipText' }, item),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dtb-chipRemove',
                      'aria-label': `${t('remove')}: ${item}`,
                      disabled,
                      onClick: () => onChange(items.filter((_, itemIndex) => itemIndex !== index)),
                    },
                    '×',
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dtb-addRow' },
          h('input', {
            className: 'dtb-input',
            type: 'text',
            value: draft,
            placeholder,
            'aria-label': label,
            disabled,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              add()
            },
          }),
          h(
            Button,
            { variant: 'outline', size: 'sm', disabled: disabled || draft.trim().length === 0, onClick: add },
            t('add'),
          ),
        ),
      )
    }

    /**
     * The Telegram settings section.
     * @param props - locale reader, the Host settings form, and credential operations.
     * @returns the settings page.
     */
    function TelegramSection(props) {
      const { t, form, token } = props
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      const [initialized, setInitialized] = React.useState(false)
      const [allowedUsers, setAllowedUsers] = React.useState([])
      const [allowedChats, setAllowedChats] = React.useState([])
      const [enabled, setEnabled] = React.useState(true)
      const [language, setLanguage] = React.useState('en')
      const [showThinking, setShowThinking] = React.useState(true)
      const [showToolCalls, setShowToolCalls] = React.useState(true)
      const [tokenDraft, setTokenDraft] = React.useState('')
      const [tokenState, setTokenState] = React.useState({
        loading: true,
        configured: false,
        writable: false,
      })
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        const off = form.subscribe(() => setSnapshot(form.getSnapshot()))
        return () => off()
      }, [form])

      React.useEffect(() => {
        if (initialized || snapshot.status !== 'ready') return
        const value = snapshot.value ?? {}
        setAllowedUsers(stringArray(value.allowedUsers))
        setAllowedChats(stringArray(value.allowedChats))
        setEnabled(value.enabled !== false)
        setLanguage(value.language === 'ru' ? 'ru' : 'en')
        setShowThinking(value.showThinking !== false)
        setShowToolCalls(value.showToolCalls !== false)
        setInitialized(true)
      }, [initialized, snapshot.status, snapshot.value])

      const value = snapshot.value ?? {}
      const tokenRef = tokenRefOfValue(value)

      React.useEffect(() => {
        let live = true
        setTokenState((previous) => ({ ...previous, loading: true }))
        token
          .read(tokenRef)
          .then((info) => {
            if (live) setTokenState({ loading: false, ...info })
          })
          .catch((cause) => {
            if (!live) return
            setTokenState({ loading: false, configured: false, writable: false })
            setError(cause?.message ?? String(cause))
          })
        return () => {
          live = false
        }
      }, [token, tokenRef])

      const runtimeLoaded = Object.hasOwn(value, 'restartRequest')
      const baseUsers = stringArray(value.allowedUsers)
      const baseChats = stringArray(value.allowedChats)
      const baseEnabled = value.enabled !== false
      const baseLanguage = value.language === 'ru' ? 'ru' : 'en'
      const baseShowThinking = value.showThinking !== false
      const baseShowToolCalls = value.showToolCalls !== false
      const dirty =
        initialized &&
        (enabled !== baseEnabled ||
          language !== baseLanguage ||
          showThinking !== baseShowThinking ||
          showToolCalls !== baseShowToolCalls ||
          !sameList(allowedUsers, baseUsers) ||
          !sameList(allowedChats, baseChats) ||
          tokenDraft.trim().length > 0)
      const writable = snapshot.writable === true
      const tokenStateLabel = tokenState.loading
        ? t('loading')
        : tokenState.configured
          ? t('tokenConfigured')
          : t('tokenMissing')

      const discard = () => {
        setAllowedUsers(baseUsers)
        setAllowedChats(baseChats)
        setEnabled(baseEnabled)
        setLanguage(baseLanguage)
        setShowThinking(baseShowThinking)
        setShowToolCalls(baseShowToolCalls)
        setTokenDraft('')
        setError(null)
        setNotice(null)
      }

      const persist = async (withRestart) => {
        if (saving) return
        const trimmed = tokenDraft.trim()
        if (trimmed.length > 0 && /\s/u.test(trimmed)) {
          setError(t('invalidToken'))
          setNotice(null)
          return
        }
        setSaving(true)
        setError(null)
        setNotice(null)
        try {
          const operations = [
            { op: 'set', path: ['enabled'], value: enabled },
            { op: 'set', path: ['language'], value: language },
            { op: 'set', path: ['showThinking'], value: showThinking },
            { op: 'set', path: ['showToolCalls'], value: showToolCalls },
            { op: 'set', path: ['allowedUsers'], value: allowedUsers },
            { op: 'set', path: ['allowedChats'], value: allowedChats },
          ]
          if (withRestart) operations.push({ op: 'set', path: ['restartRequest'], value: Date.now() })
          const accepted = await form.mutate(operations)
          if (!accepted) throw new Error(withRestart ? t('restartFailed') : t('saveFailed'))
          if (trimmed.length > 0) {
            const info = await token.save(tokenRef, trimmed)
            setTokenState({ loading: false, ...info })
            setTokenDraft('')
          }
          setNotice(withRestart ? t('restartRequested') : t('saved'))
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setSaving(false)
        }
      }

      const save = () => persist(false)
      const restart = () => persist(true)

      const removeToken = async () => {
        if (saving || !tokenState.writable) return
        if (typeof window !== 'undefined' && !window.confirm(t('removeTokenConfirm'))) return
        setSaving(true)
        setError(null)
        setNotice(null)
        try {
          const info = await token.clear(tokenRef)
          setTokenState({ loading: false, ...info })
          setNotice(t('tokenRemoved'))
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setSaving(false)
        }
      }

      if (snapshot.status === 'unavailable') {
        return h(PageFrame, { t }, h('p', { className: 'dtb-notice' }, t('unavailable')))
      }

      if (snapshot.status !== 'ready' || !initialized) {
        return h(PageFrame, { t }, h('p', { className: 'dtb-loading' }, t('loadingSettings')))
      }

      return h(
        PageFrame,
        { t },
        writable ? null : h('p', { className: 'dtb-notice' }, t('readOnly')),
        runtimeLoaded ? null : h('p', { className: 'dtb-notice' }, t('hostNeedsRestart')),
        h(
          'section',
          { className: 'dtb-card' },
          h('h3', { className: 'dtb-cardTitle' }, t('botToken')),
          h(SettingsSecretField, {
            id: 'dsh-telegram-bot-token',
            label: t('tokenValue'),
            hint: tokenState.writable ? t('tokenHint') : t('tokenReadOnly'),
            disabled: saving || tokenState.loading || !tokenState.writable,
            text: tokenDraft,
            configured: tokenState.configured,
            stateLabel: tokenStateLabel,
            onEdit: setTokenDraft,
          }),
          tokenState.configured && tokenState.writable
            ? h(
                'div',
                { className: 'dtb-addRow' },
                h(
                  Button,
                  { variant: 'ghost', size: 'sm', disabled: saving, onClick: removeToken },
                  t('removeToken'),
                ),
              )
            : null,
        ),
        h(
          'section',
          { className: 'dtb-card' },
          h('h3', { className: 'dtb-cardTitle' }, t('access')),
          h(
            'div',
            { className: 'dtb-toggleRow' },
            h(
              'div',
              { className: 'dtb-toggleCopy' },
              h('span', { className: 'dtb-label' }, t('botLanguage')),
              h('p', { className: 'dtb-hint' }, t('botLanguageHint')),
            ),
            h(
              'select',
              {
                className: 'dtb-select',
                value: language,
                disabled: saving || !writable,
                onChange: (event) => setLanguage(event.target.value),
                'aria-label': t('botLanguage'),
              },
              h('option', { value: 'en' }, 'English'),
              h('option', { value: 'ru' }, 'Русский'),
            ),
          ),
          h(
            'div',
            { className: 'dtb-toggleRow' },
            h(
              'div',
              { className: 'dtb-toggleCopy' },
              h('span', { className: 'dtb-label' }, t('enabled')),
              h('p', { className: 'dtb-hint' }, t('enabledHint')),
            ),
            h(Switch, {
              checked: enabled,
              label: t('enabled'),
              disabled: saving || !writable,
              onChange: setEnabled,
            }),
          ),
          h(
            'div',
            { className: 'dtb-toggleRow' },
            h(
              'div',
              { className: 'dtb-toggleCopy' },
              h('span', { className: 'dtb-label' }, t('showThinking')),
              h('p', { className: 'dtb-hint' }, t('showThinkingHint')),
            ),
            h(Switch, {
              checked: showThinking,
              label: t('showThinking'),
              disabled: saving || !writable,
              onChange: setShowThinking,
            }),
          ),
          h(
            'div',
            { className: 'dtb-toggleRow' },
            h(
              'div',
              { className: 'dtb-toggleCopy' },
              h('span', { className: 'dtb-label' }, t('showToolCalls')),
              h('p', { className: 'dtb-hint' }, t('showToolCallsHint')),
            ),
            h(Switch, {
              checked: showToolCalls,
              label: t('showToolCalls'),
              disabled: saving || !writable,
              onChange: setShowToolCalls,
            }),
          ),
          h(ListEditor, {
            t,
            label: t('allowedUsers'),
            hint: t('allowedUsersHint'),
            items: allowedUsers,
            onChange: setAllowedUsers,
            placeholder: t('placeholderUsers'),
            emptyLabel: t('emptyUsers'),
            disabled: saving || !writable,
          }),
          h(ListEditor, {
            t,
            label: t('allowedChats'),
            hint: t('allowedChatsHint'),
            items: allowedChats,
            onChange: setAllowedChats,
            placeholder: t('placeholderChats'),
            emptyLabel: t('emptyChats'),
            disabled: saving || !writable,
          }),
        ),
        h(
          'footer',
          { className: 'dtb-footer' },
          h(
            'div',
            {
              className: error ? 'dtb-message dtb-messageError' : notice ? 'dtb-message dtb-messageOk' : 'dtb-message',
              role: 'status',
              'aria-live': 'polite',
            },
            error ?? notice ?? '',
          ),
          h(
            'div',
            { className: 'dtb-footerActions' },
            h(
              Button,
              { variant: 'outline', disabled: !dirty || saving, onClick: discard },
              t('discard'),
            ),
            h(
              Button,
              { variant: 'outline', disabled: saving || !writable || !runtimeLoaded, onClick: restart },
              t('restart'),
            ),
            h(
              Button,
              {
                variant: 'primary',
                disabled: !dirty || saving || !writable,
                onClick: save,
              },
              saving ? t('saving') : t('save'),
            ),
          ),
        ),
      )
    }


    /**
     * Informational card on the Plugins page's bundle detail. All controls live
     * in Settings → Telegram; this card only points there and lists the manual
     * configuration files. The bundle switch is the plugin's on/off control.
     * @param props - locale reader and slot view.
     * @returns the summary line or the settings pointer.
     */
    function BundleSettings(props) {
      const { t, view } = props
      if (view === 'summary') {
        return h('span', null, `${t('bundleSummary')} · ${t('pluginPageLocation')}`)
      }
      return h(
        'div',
        { className: 'dtb-plugin' },
        h('p', { className: 'dtb-description' }, t('pluginPageDescription')),
        h(
          'p',
          { className: 'dtb-notice' },
          t('pluginConfigFiles'),
          h('br'),
          h('code', null, '~/.dsh/profiles/web/cordis.patch.yml'),
          ` — ${t('pluginConfigSettings')}`,
          h('br'),
          h('code', null, '~/.dsh/.credentials.yaml'),
          ` — ${t('pluginConfigToken')}`,
          h('br'),
          h('code', null, '~/.dsh/.env'),
          ` — ${t('pluginConfigEnv')}`,
        ),
      )
    }

    /** Required client services. */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

    /**
     * Register the Telegram section while the Host serves this bundle's
     * settings namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const offEn = ctx.locale.register(NS, 'en', en)
        const offRu = ctx.locale.register(NS, 'ru', ru)
        return () => {
          offRu()
          offEn()
        }
      }, 'dsh-telegram-bot: dictionaries')
      ctx.effect(() => {
        // Russian needs a selectable language pack. If another plugin already
        // registered it, keep that definition and only contribute our copy.
        try {
          return ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })
        } catch {
          return () => {}
        }
      }, 'dsh-telegram-bot: russian language')

      const form = ctx.configForms.get(NS)
      const token = {
        read: (ref) => readToken(ctx, ref),
        save: (ref, value) => saveToken(ctx, ref, value),
        clear: (ref) => clearToken(ctx, ref),
      }

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'telegram',
                  order: 50,
                  label: () => t('nav'),
                  inject: () => ({ t, form, token }),
                },
                TelegramSection,
              ),
            ),
          ),
        'dsh-telegram-bot: settings page',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-telegram-bot',
                locale: NS,
                inject: () => ({ t }),
              },
              BundleSettings,
            ),
          ),
        'dsh-telegram-bot: bundle settings',
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

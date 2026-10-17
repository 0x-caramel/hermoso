/**
 * The native-dialog way of asking for consent (main process, Electron-free through a structural `dialog`).
 *
 * Used only when no window shows the request in time (see consent.ts): a request must never sit unseen.
 * The safe choice is the default one, and closing the dialog any other way is a no.
 */

import type { ConsentAnswer, ConsentPrompt } from './consent'

export interface NativeDialog {
  showMessageBox: (
    window: any,
    options: {
      buttons: string[]
      cancelId: number
      defaultId: number
      detail: string
      message: string
      noLink: boolean
      signal?: AbortSignal
      title: string
      type: 'question'
    }
  ) => Promise<{ response: number }>
}

export interface NativeConsentDeps {
  dialog: NativeDialog
  /** The window to attach the dialog to (the app's main window), or null. */
  window: () => unknown
}

export function createNativeConsent(deps: NativeConsentDeps) {
  return async (prompt: ConsentPrompt, signal: AbortSignal): Promise<ConsentAnswer | null> => {
    const buttons = prompt.allowKey
      ? ['Allow once', `Always allow ${prompt.allowLabel ?? 'this'}`, 'Deny']
      : ['Allow once', 'Deny']

    const deny = buttons.length - 1

    const { response } = await deps.dialog.showMessageBox(deps.window() ?? null, {
      buttons,
      cancelId: deny,
      defaultId: deny,
      detail: [...prompt.lines, ...(prompt.code ? [prompt.code] : [])].join('\n\n'),
      message: prompt.title,
      noLink: true,
      signal,
      title: 'Hermoso',
      type: 'question'
    })

    // The window answered first and dismissed this dialog: not an answer of ours.
    if (signal.aborted) {
      return null
    }

    if (response === 0) {
      return 'once'
    }

    return prompt.allowKey && response === 1 ? 'always' : 'deny'
  }
}

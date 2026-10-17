/**
 * The person's yes, asked in Hermoso's own window.
 *
 * Mounted once (next to the status-bar chip, which is always there), it shows the oldest request main is waiting
 * on, says to main that it is showing it (so no native dialog is needed), and sends back exactly what the person
 * chose. Closing it any other way (Escape) is a no. The safe button has the focus.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect } from 'react'

import { $consent, ackConsent, answerConsent } from './store'
import { STRINGS } from './strings'

const T = STRINGS.consent

export function ConsentHost() {
  const queue = useValue($consent)
  const prompt = queue[0]
  const id = prompt?.id

  useEffect(() => {
    if (id) {
      ackConsent(id)
    }
  }, [id])

  if (!prompt) {
    return null
  }

  return (
    <Dialog onOpenChange={open => !open && void answerConsent(prompt.id, 'deny')} open>
      <DialogContent onInteractOutside={event => event.preventDefault()} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
          <DialogDescription className="sr-only">{T.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm text-(--ui-text-secondary)">
          {prompt.lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>

        <DialogFooter>
          <Button autoFocus onClick={() => void answerConsent(prompt.id, 'deny')} type="button" variant="outline">
            {T.deny}
          </Button>
          <Button onClick={() => void answerConsent(prompt.id, 'once')} type="button" variant="secondary">
            {T.once}
          </Button>
          {prompt.allowKey && (
            <Button onClick={() => void answerConsent(prompt.id, 'always')} type="button">
              {T.always(prompt.allowLabel ?? '')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

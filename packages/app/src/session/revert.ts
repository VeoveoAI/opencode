import type { SessionMessageUser } from "@opencode/client/promise"
import { useComposerState } from "@/composer/persistence"
import { useData } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useLanguage } from "@/runtime/i18n/language"

import { extractPromptContext, extractPromptFromMessage } from "@/composer/prompt"
import { promptLength } from "@/composer/prompt-parts"

// VeoveoAI fork: Lore owns history and undo, so rewind, undo and redo are removed. Only recall stays.
export function createSessionRevert() {
  const prompt = useComposerState()
  const data = useData()
  const location = useWorkspaceLocation()
  const language = useLanguage()

  const restore = (target: ReturnType<typeof prompt.capture>, message: SessionMessageUser) => {
    const restored = extractPromptFromMessage(message, {
      directory: location().directory,
      attachmentName: language.t("common.attachment"),
      sessionTitle: (id) => data.session.get(id)?.title,
    })

    const context = extractPromptContext(message, { directory: location().directory })

    target.set(restored, promptLength(restored))
    // The restored prompt replaces the draft, so chips from an earlier restore do not ride along.
    target.context.replace([...context.comments, ...context.files])
  }

  /** Puts a sent prompt back in the composer without rewinding the Session. */
  const recall = (message: SessionMessageUser) => restore(prompt.capture(), message)

  return { recall }
}

import { FileIcon } from "@opencode/ui/file-icon"
import { useI18n } from "@opencode/ui/context/i18n"
import "./session-review-v2.css"

export function SessionReviewEmptyNoGitV2() {
  const i18n = useI18n()

  return (
    <div data-slot="session-review-v2-empty-no-git">
      <FileIcon node={{ path: ".gitignore", type: "file" }} mono />
      <div data-slot="session-review-v2-empty-no-git-title">{i18n.t("ui.sessionReviewV2.empty.noGit.title")}</div>
    </div>
  )
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { localFileRef } from '@/common/types/chatFile';
import type { LocalFileLinkReference } from '@/renderer/components/Markdown/markdownUtils';
import { getContentTypeByExtension } from '@/renderer/pages/conversation/Preview/fileUtils';
import {
  useOptionalPreviewContext,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { resolvePreviewPayload, upgradeFileRef } from '@/renderer/utils/file/previewPayload';
import { resolveWorkspacePath } from '@/renderer/utils/file/workspacePath';
import { getCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { useCallback } from 'react';

const getFileNameFromPath = (file_path: string): string => {
  const normalized = file_path.replace(/\\/g, '/');
  return normalized.split('/').pop() || file_path;
};

const getPreviewLanguage = (file_name: string): string => {
  const dotIndex = file_name.lastIndexOf('.');
  return dotIndex >= 0 ? file_name.slice(dotIndex + 1).toLowerCase() : '';
};

const useLocalFileOpener = (
  openPreview: PreviewContextValue['openPreview'] | undefined,
  workspace: string | undefined,
  relativeTo: string | undefined
) =>
  useCallback(
    async (linkPath: string, reference?: LocalFileLinkReference) => {
      if (!openPreview) return;
      // `index.html` in a message means the file under the workspace; nothing else reads it that way.
      const file_path = resolveWorkspacePath(linkPath, relativeTo);
      const fileName = getFileNameFromPath(file_path);
      const contentType = getContentTypeByExtension(fileName);
      // Local-file links point at a backend-host absolute path (no pe identity) →
      // a Local ChatFileRef, read over /api/fs/content.
      //
      // Upgraded before anything else uses it: the same file opened from the
      // explorer carries a project ref, so without this the two entry points would
      // produce two tabs for one file, and this one would get no change signals.
      const fileRef = await upgradeFileRef(localFileRef(file_path), getCurrentProject());

      try {
        // Shared gate: applies the size ceiling, reads content only when the file
        // is within it, and returns the mtime used as the save-time If-Match. It
        // throws when the file is missing, which is the existence pre-check this
        // entry point has always relied on.
        const payload = await resolvePreviewPayload(fileRef, contentType);

        openPreview(
          payload.content,
          contentType,
          {
            title: fileName,
            file_name: fileName,
            fileRef,
            file_path,
            workspace,
            language: getPreviewLanguage(fileName),
            targetLine: reference?.line,
            targetColumn: reference?.column,
            // An oversized file is read-only: no content was read, so there is
            // nothing to edit and no partial content that could be written back.
            editable: contentType === 'markdown' || contentType === 'image' || payload.oversized ? false : undefined,
            oversized: payload.oversized,
            sizeBytes: payload.sizeBytes,
            thresholdBytes: payload.thresholdBytes,
            lastModified: payload.lastModified,
          },
          { replace: true }
        );
      } catch {
        openPreview(
          '',
          contentType,
          {
            title: fileName,
            file_name: fileName,
            fileRef,
            file_path,
            workspace,
            language: getPreviewLanguage(fileName),
            targetLine: reference?.line,
            targetColumn: reference?.column,
            editable: false,
            missingFile: true,
          },
          { replace: true }
        );
      }
    },
    [openPreview, workspace, relativeTo]
  );

/**
 * @param workspace the conversation's workspace, recorded on the tab
 * @param relativeTo what a relative link is relative to: the workspace, or the directory of the document that carries
 *   the link
 */
export const useLocalFilePreview = (workspace?: string, relativeTo: string | undefined = workspace) => {
  const { openPreview } = usePreviewContext();
  return useLocalFileOpener(openPreview, workspace, relativeTo);
};

/**
 * The same, for a place that may be drawn with no preview panel around it (a test, a window without one): undefined
 * there, so the caller leaves the path as text.
 */
export const useOptionalLocalFilePreview = (workspace?: string) => {
  const preview = useOptionalPreviewContext();
  const open = useLocalFileOpener(preview?.openPreview, workspace, workspace);
  return preview ? open : undefined;
};

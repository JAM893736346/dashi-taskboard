import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  createProjectWorkspace,
  pickProjectParent,
  previewProjectWorkspace,
} from "../api";
import type { ProjectWorkspaceCreateResult, ProjectWorkspacePreview } from "../types";
import { LinearIcon } from "./LinearIcon";

interface ProjectCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (result: ProjectWorkspaceCreateResult) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "无法创建项目";
}

export function ProjectCreateDialog({
  open,
  onClose,
  onCreated,
}: ProjectCreateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [preview, setPreview] = useState<ProjectWorkspacePreview | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.showModal();
    nameRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, [open]);

  useEffect(() => {
    const cleanName = name.trim();
    if (!cleanName || !parentPath) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void previewProjectWorkspace(cleanName, parentPath, controller.signal).then(
        (nextPreview) => {
          setPreview(nextPreview);
          setError(null);
        },
        (previewError) => {
          if ((previewError as Error).name !== "AbortError") {
            setPreview(null);
            setError(messageFromError(previewError));
          }
        },
      );
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [name, parentPath]);

  async function chooseParent() {
    if (choosing || submitting) return;
    setChoosing(true);
    setError(null);
    try {
      const selected = await pickProjectParent();
      if (selected) setParentPath(selected);
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setChoosing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError("请输入项目名称");
      nameRef.current?.focus();
      return;
    }
    if (!parentPath || !preview) {
      setError("请选择项目父目录");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createProjectWorkspace(cleanName, parentPath));
    } catch (nextError) {
      setError(messageFromError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="project-create-dialog"
      aria-labelledby="project-create-title"
      onCancel={(event) => {
        if (submitting || choosing) event.preventDefault();
        else onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header className="project-create-header">
          <strong id="project-create-title">创建项目</strong>
          <button
            type="button"
            className="icon-button dialog-close"
            aria-label="关闭"
            title="关闭"
            disabled={submitting || choosing}
            onClick={onClose}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <div className="project-create-body">
          <label>
            <span>项目名称</span>
            <input
              ref={nameRef}
              value={name}
              maxLength={200}
              disabled={submitting}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>

          <label>
            <span>父目录</span>
            <div className="project-create-directory">
              <input
                value={parentPath}
                readOnly
                placeholder="选择目录"
                aria-label="项目父目录"
              />
              <button
                type="button"
                className="icon-button"
                aria-label="选择项目父目录"
                title="选择目录"
                disabled={choosing || submitting}
                onClick={() => void chooseParent()}
              >
                <LinearIcon name="folder" />
              </button>
            </div>
          </label>

          <label>
            <span>项目目录</span>
            <input value={preview?.workspacePath ?? ""} readOnly aria-label="最终项目目录" />
          </label>

          {error && <div className="form-error" role="alert">{error}</div>}
        </div>

        <footer className="project-create-footer">
          <button
            type="button"
            className="button secondary"
            disabled={submitting || choosing}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={submitting || choosing || !name.trim() || !preview}
          >
            {submitting ? "正在创建…" : "创建项目"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

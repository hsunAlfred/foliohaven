import { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { html } from '@codemirror/lang-html';

const external = Annotation.define<boolean>();
export function HtmlEditor({
  value,
  onChange,
  readOnly,
  location,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  location?: {
    readonly line: number;
    readonly column: number;
    readonly version: number;
  } | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const compartment = useRef(new Compartment());
  const [initial] = useState(() => ({ value, readOnly }));
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          html(),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'HTML 正文',
            role: 'textbox',
            'aria-multiline': 'true',
            spellcheck: 'false',
            'data-field': 'contentHtml',
          }),
          compartment.current.of([
            EditorState.readOnly.of(initial.readOnly),
            EditorView.editable.of(!initial.readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(external),
              )
            )
              change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
    // Initial document and permission are subsequently synchronized through the
    // dedicated effects; recreating the editor would discard undo history.
  }, [initial]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: external.of(true),
      });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !location) return;
    const line = editor.state.doc.line(
      Math.max(1, Math.min(location.line, editor.state.doc.lines)),
    );
    const anchor =
      line.from + Math.max(0, Math.min(location.column - 1, line.length));
    editor.dispatch({
      selection: { anchor },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
    editor.focus();
  }, [location]);
  return <div className="html-editor" ref={host} />;
}

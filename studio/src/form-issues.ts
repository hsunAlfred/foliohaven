import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';
import type { InputIssue } from './validation.js';

const FormIssuesContext = createContext<readonly InputIssue[]>([]);

export function FormIssuesProvider({
  issues,
  children,
}: {
  issues: readonly InputIssue[];
  children: ReactNode;
}) {
  return createElement(FormIssuesContext.Provider, { value: issues }, children);
}

export function useFormFieldIssues(field: string | undefined) {
  const issues = useContext(FormIssuesContext);
  return field === undefined
    ? []
    : issues.filter((issue) => issue.path.join('.') === field);
}

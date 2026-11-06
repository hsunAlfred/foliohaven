import {
  attr,
  isElement,
  parseHtml,
  type HtmlElement,
  type HtmlNode,
} from './parser.js';

function isContainer(element: HtmlElement): boolean {
  return element.tagName === 'div' || element.tagName === 'section';
}

function isWhitespaceOrComment(node: HtmlNode): boolean {
  return (
    node.nodeName === '#comment' ||
    (node.nodeName === '#text' && 'value' in node && node.value.trim() === '')
  );
}

function startsWithHeading(block: HtmlElement, heading: HtmlElement): boolean {
  let child = heading;
  while (child !== block) {
    const parent = child.parentNode;
    if (parent === null || !isElement(parent) || !isContainer(parent))
      return false;
    const index = parent.childNodes.indexOf(child);
    if (
      index < 0 ||
      parent.childNodes
        .slice(0, index)
        .some((node) => !isWhitespaceOrComment(node))
    )
      return false;
    child = parent;
  }
  return true;
}

/** Extract one complete authored heading block without reserializing either part. */
export function extractHtmlHeadingBlock(
  contentHtml: string,
  headingId: string,
): { readonly contentHtml: string; readonly blockHtml: string } | undefined {
  const parsed = parseHtml(contentHtml);
  if (parsed.diagnostics.some((item) => item.severity === 'error'))
    return undefined;
  const matches = parsed.elements.filter(
    (element) => attr(element, 'id') === headingId,
  );
  const heading = matches[0];
  if (
    matches.length !== 1 ||
    heading === undefined ||
    !/^h[2-6]$/u.test(heading.tagName)
  )
    return undefined;

  let block = heading;
  while (block.parentNode !== null && isElement(block.parentNode))
    block = block.parentNode;
  const location = block.sourceCodeLocation;
  if (
    block.parentNode?.nodeName !== '#document-fragment' ||
    !isContainer(block) ||
    location?.startTag === undefined ||
    location.endTag === undefined ||
    !Number.isInteger(location.startOffset) ||
    !Number.isInteger(location.endOffset) ||
    location.startOffset < 0 ||
    location.endOffset > contentHtml.length ||
    location.startOffset >= location.endOffset ||
    !startsWithHeading(block, heading)
  )
    return undefined;

  // Template contents also have a fragment parent; their source still sits
  // inside the template element and must never be promoted into visible content.
  if (
    parsed.elements.some((element) => {
      const enclosing = element.sourceCodeLocation;
      return (
        element !== block &&
        enclosing !== undefined &&
        enclosing !== null &&
        enclosing.startOffset < location.startOffset &&
        enclosing.endOffset >= location.endOffset
      );
    })
  )
    return undefined;

  const level = Number(heading.tagName.slice(1));
  if (
    parsed.elements.some(
      (element) =>
        element !== heading &&
        /^h[1-6]$/u.test(element.tagName) &&
        Number(element.tagName.slice(1)) <= level &&
        element.sourceCodeLocation !== undefined &&
        element.sourceCodeLocation !== null &&
        element.sourceCodeLocation.startOffset >= location.startOffset &&
        element.sourceCodeLocation.startOffset < location.endOffset,
    )
  )
    return undefined;

  return {
    contentHtml:
      contentHtml.slice(0, location.startOffset) +
      contentHtml.slice(location.endOffset),
    blockHtml: contentHtml.slice(location.startOffset, location.endOffset),
  };
}

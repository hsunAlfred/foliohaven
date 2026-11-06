/** A deferred focus action must yield when the user has moved elsewhere. */
export function captureFocusOwner(ownerDocument: Document): () => boolean {
  const previousFocus = ownerDocument.activeElement;
  return () => {
    const currentFocus = ownerDocument.activeElement;
    return (
      currentFocus === previousFocus ||
      (previousFocus !== null &&
        !previousFocus.isConnected &&
        currentFocus === ownerDocument.body)
    );
  };
}

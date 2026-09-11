import type { Text } from "@codemirror/state";
import { readReview, type DocumentReview } from "iterate/document-review";

const reviews = new WeakMap<Text, DocumentReview>();

/** Share one review parse across syntax, decorations and editing for an immutable document. */
export function reviewForDocument(doc: Text): DocumentReview {
  let review = reviews.get(doc);
  if (!review) {
    review = readReview(doc.toString());
    reviews.set(doc, review);
  }
  return review;
}

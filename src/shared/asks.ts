/** A structured question from a Droid session, shown one menu at a time. */
export interface Choice {
  number: number;
  label: string;
  description?: string;
  selected?: boolean;
}

export interface Menu {
  question?: string;
  choices: Choice[];
  /** Focused option; multi-select also uses choices.length for text and length + 1 for Submit. */
  pointer?: number;
  freeText: boolean;
  multiSelect?: boolean;
  /** AskUser's final review, bound to these exact summary lines before Enter submits. */
  review?: string[];
}

/** Whether the menu takes a typed answer. */
export function menuTakesText(menu: Menu): boolean {
  return menu.freeText;
}

/** The same question with the same choices: what was shown is still what an answer would pick. */
export function sameMenu(a: Menu | undefined, b: Menu | undefined): boolean {
  if (!a || !b || !Array.isArray(a.choices) || !Array.isArray(b.choices)) return false;
  return (
    a.question === b.question &&
    !!a.multiSelect === !!b.multiSelect &&
    a.freeText === b.freeText &&
    JSON.stringify(a.review) === JSON.stringify(b.review) &&
    a.choices.length === b.choices.length &&
    a.choices.every((c, i) => !!c && c.number === b.choices[i]?.number && c.label === b.choices[i]?.label && c.description === b.choices[i]?.description)
  );
}

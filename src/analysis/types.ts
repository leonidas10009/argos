export interface RawElement {
  tag: string;
  selector: string;
  id: string;
  class: string;
  text: string;
  type: string;
  attr: Record<string, string>;
  children: RawElement[];
  parent: string;
  depth: number;
}

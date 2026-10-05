declare module "bpmn-moddle" {
  export interface ModdleElement {
    readonly $type: string;
    id?: string;
    get(name: string): unknown;
    set(name: string, value: unknown): void;
  }

  export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface ToXMLOptions {
    format?: boolean;
    preamble?: boolean;
  }

  export interface ToXMLResult {
    xml: string;
  }

  export interface FromXMLResult {
    rootElement: ModdleElement;
    references: ModdleElement[];
    warnings: unknown[];
    elementsById?: Record<string, ModdleElement>;
  }

  export class BpmnModdle {
    constructor(packages?: unknown, options?: Record<string, unknown>);
    create(name: string, attrs?: Record<string, unknown>): ModdleElement;
    fromXML(xml: string | Promise<string>): Promise<FromXMLResult>;
    toXML(
      element: ModdleElement,
      options?: ToXMLOptions,
    ): Promise<ToXMLResult>;
  }
}
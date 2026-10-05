declare module "bpmn-auto-layout" {
  /**
   * Create the graphical representation (DI) of the given BPMN 2.0 XML and
   * return the XML with layout information added. Resolves asynchronously.
   */
  export function layoutProcess(xml: string): Promise<string>;
}
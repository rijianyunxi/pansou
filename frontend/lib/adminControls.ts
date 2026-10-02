import { isVNode, type VNode } from "vue";

export const EMPTY_SELECT_VALUE = "__pansou_admin_empty__";
interface AdminSelectOption {
  value: string;
  text: string;
  disabled: boolean;
}

function optionText(children: VNode["children"] | unknown): string {
  if (Array.isArray(children))
    return children
      .map((child) =>
        isVNode(child) ? optionText(child.children) : optionText(child),
      )
      .join("");
  return typeof children === "string" || typeof children === "number"
    ? String(children)
    : "";
}

/** Convert option/fragment slots into one canonical Select list. */
export function selectOptions(nodes: VNode[]): AdminSelectOption[] {
  return nodes.flatMap((node) => {
    if (node.type === "option") {
      const text = optionText(node.children);
      return [
        {
          value: String(node.props?.value ?? text) || EMPTY_SELECT_VALUE,
          text,
          disabled: node.props?.disabled === "" || !!node.props?.disabled,
        },
      ];
    }
    return Array.isArray(node.children)
      ? selectOptions(node.children.filter(isVNode))
      : [];
  });
}

export function selectValue(
  value: unknown,
  previous?: string | number,
): string | number {
  const normalized = value === EMPTY_SELECT_VALUE ? "" : String(value);
  return typeof previous === "number" ? Number(normalized) : normalized;
}

export function checkboxState(
  model?: boolean | unknown[],
  checked?: boolean,
  value?: unknown,
  indeterminate = false,
): boolean | "indeterminate" {
  return indeterminate
    ? "indeterminate"
    : Array.isArray(model)
      ? model.includes(value)
      : (model ?? checked ?? false);
}

export function checkboxValue(
  model: boolean | unknown[] | undefined,
  value: unknown,
  checked: boolean,
): boolean | unknown[] {
  if (!Array.isArray(model)) return checked;
  return checked
    ? model.includes(value)
      ? [...model]
      : [...model, value]
    : model.filter((item) => item !== value);
}

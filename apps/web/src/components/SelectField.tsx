import React, { useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export function SelectField({ value, options, onChange, ariaLabel, className = "", disabled = false }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const [dropUp, setDropUp] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function show() {
    if (disabled || options.length === 0) return;
    const rect = root.current?.getBoundingClientRect();
    if (rect) setDropUp(window.innerHeight - rect.bottom < 260 && rect.top > 260);
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setHighlighted(index);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      setHighlighted((current) => {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (current + delta + options.length) % options.length;
      });
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) show();
      setHighlighted(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(highlighted);
      else show();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return <div ref={root} className={`select-field ${dropUp ? "drop-up" : ""} ${className}`.trim()}>
    <button
      type="button"
      className="select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-controls={listId}
      aria-expanded={open}
      aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
      disabled={disabled}
      onClick={() => open ? setOpen(false) : show()}
      onKeyDown={handleKeyDown}
    >
      <span><b>{selected?.label ?? "请选择"}</b>{selected?.description && <small>{selected.description}</small>}</span>
      <i aria-hidden="true">⌄</i>
    </button>
    {open && <div id={listId} className="select-options" role="listbox" aria-label={ariaLabel}>
      {options.map((option, index) => <button
        type="button"
        id={`${listId}-${index}`}
        role="option"
        aria-selected={option.value === value}
        className={`${option.value === value ? "selected" : ""} ${index === highlighted ? "highlighted" : ""}`.trim()}
        key={option.value}
        onPointerMove={() => setHighlighted(index)}
        onClick={() => choose(index)}
      ><span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>)}
    </div>}
  </div>;
}

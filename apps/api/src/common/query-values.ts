import { applyDecorators } from "@nestjs/common";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/** Repeated query parameters; a single occurrence is still a one-item array. */
export function QueryValues(
  options: {
    values?: readonly string[];
    maxLength?: number;
    pattern?: RegExp;
  } = {},
) {
  return applyDecorators(
    ApiPropertyOptional({
      type: [String],
      ...(options.values ? { enum: [...options.values], isArray: true } : {}),
      maxItems: 100,
      description:
        "OR within this filter; overrides the legacy singular parameter. Repeat the query parameter for multiple values.",
    }),
    IsOptional(),
    Transform(({ value }) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
    IsArray(),
    ArrayMaxSize(100),
    IsString({ each: true }),
    Matches(/\S/, { each: true }),
    MaxLength(options.maxLength ?? 64, { each: true }),
    ...(options.values ? [IsIn(options.values, { each: true })] : []),
    ...(options.pattern ? [Matches(options.pattern, { each: true })] : []),
  );
}

export const MANAGER_KEY_PATTERN =
  /^(?:id:[^\s].{0,63}|code:[^\s].{0,63}|name:.{1,512}|unassigned)$/;

export function selectedValues(values?: string[], legacy?: string): string[] {
  return [...new Set(values ?? (legacy ? [legacy] : []))];
}

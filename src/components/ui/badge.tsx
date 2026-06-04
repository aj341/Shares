import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        brand:
          "border-transparent bg-brand-muted [color:hsl(var(--brand))]",
        violet:
          "border-transparent bg-violet-muted [color:hsl(var(--violet))]",
        positive:
          "border-transparent bg-positive-muted text-positive-foreground [color:hsl(var(--positive))]",
        negative:
          "border-transparent bg-negative-muted [color:hsl(var(--negative))]",
        warning:
          "border-transparent bg-warning-muted [color:hsl(var(--warning))]",
        neutral:
          "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly headerAction?: ReactNode;
  /** Force the grouped card background; Android otherwise lists options flat. */
  readonly card?: boolean;
}) {
  return (
    <View className="gap-2">
      {props.title || props.headerAction ? (
        <View
          className={
            Platform.OS === "android"
              ? "flex-row items-center justify-between gap-3 px-4"
              : "flex-row items-center justify-between gap-3 px-2"
          }
        >
          {props.title ? (
            <Text
              className={
                Platform.OS === "android"
                  ? "text-sm font-t3-medium text-primary"
                  : "text-sm font-t3-medium text-foreground-muted"
              }
            >
              {props.title}
            </Text>
          ) : null}
          {props.headerAction}
        </View>
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "overflow-hidden rounded-[28px] bg-card"
            : props.card
              ? "overflow-hidden rounded-[24px] border-continuous bg-card"
              : "overflow-hidden rounded-[24px] border-continuous bg-card android:bg-transparent"
        }
      >
        {props.children}
      </View>
    </View>
  );
}

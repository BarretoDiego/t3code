import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly headerAction?: ReactNode;
  /** Force the grouped card background; Android otherwise lists options flat. */
  readonly card?: boolean;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3 px-2">
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
        {props.headerAction}
      </View>
      <View
        className={
          props.card
            ? "overflow-hidden rounded-[24px] border-continuous bg-card"
            : "overflow-hidden rounded-[24px] border-continuous bg-card android:bg-transparent"
        }
      >
        {props.children}
      </View>
    </View>
  );
}

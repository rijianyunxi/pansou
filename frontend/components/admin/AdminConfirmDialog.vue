<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "./ui/alert-dialog";
import { AlertDialogCancel } from "reka-ui";
import { Button } from "./ui/button";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
const { open, message, answer } = useAdminConfirm();
</script>
<template>
  <AlertDialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) answer(false);
      }
    "
    ><AlertDialogContent
      ><AlertDialogHeader
        ><AlertDialogTitle>确认此操作？</AlertDialogTitle
        ><AlertDialogDescription class="tw:leading-6">{{
          message
        }}</AlertDialogDescription></AlertDialogHeader
      ><AlertDialogFooter
        ><AlertDialogCancel as-child
          ><Button type="button" variant="outline" @click="answer(false)"
            >取消</Button
          ></AlertDialogCancel
        ><Button type="button" variant="destructive" @click="answer(true)"
          >确认操作</Button
        ></AlertDialogFooter
      ></AlertDialogContent
    ></AlertDialog
  >
</template>

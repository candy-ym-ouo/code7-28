<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch } from "../lib/api";

type Contribution = {
  id: string;
  category_key: string;
  status: string;
  created_at: string;
  updated_at: string;
  revision_status: string;
  payload: { title: string; description: string };
  rejection_reason_code: string | null;
  moderation_notes: string | null;
};

const items = ref<Contribution[]>([]);
const error = ref("");
const loading = ref(true);

const statusLabels: Record<string, string> = {
  draft: "草稿", pending: "审核中", published: "已发布", rejected: "已拒绝",
  changes_requested: "需要修改", hidden: "已隐藏", deleted: "已删除"
};

async function load() {
  loading.value = true;
  try {
    items.value = await apiFetch<Contribution[]>("/me/features");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function remove(id: string) {
  if (!window.confirm("确认删除这条内容？删除后公共地图将立即不可见。")) return;
  try {
    await apiFetch(`/features/${id}`, { method: "DELETE" });
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "删除失败";
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-heading">
      <div><h1>我的投稿</h1><p>查看审核状态、拒绝原因，继续编辑或创建修订。</p></div>
      <RouterLink class="button" to="/submit">新建投稿</RouterLink>
    </div>
    <p v-if="error" class="error-box">{{ error }}</p>
    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="!items.length" class="card empty">还没有投稿。</div>
    <div v-else class="card">
      <table class="table">
        <thead><tr><th>标题</th><th>分类</th><th>状态</th><th>修订状态</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>
              <strong>{{ item.payload?.title ?? "未命名" }}</strong>
              <p v-if="item.rejection_reason_code" class="muted">{{ item.rejection_reason_code }}{{ item.moderation_notes ? `：${item.moderation_notes}` : "" }}</p>
            </td>
            <td>{{ item.category_key }}</td>
            <td><span class="badge" :class="item.status">{{ statusLabels[item.status] ?? item.status }}</span></td>
            <td>{{ statusLabels[item.revision_status] ?? item.revision_status }}</td>
            <td>{{ new Date(item.updated_at).toLocaleString() }}</td>
            <td>
              <div class="inline">
                <RouterLink v-if="item.revision_status !== 'pending'" class="button secondary small" :to="`/submit/${item.id}`">
                  {{ item.status === "published" && item.revision_status === "published" ? "创建修订" : "继续编辑" }}
                </RouterLink>
                <span v-else class="badge pending">修订审核中</span>
                <RouterLink v-if="item.status === 'published'" class="button ghost small" :to="`/features/${item.id}`">查看</RouterLink>
                <button class="button danger small" type="button" @click="remove(item.id)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

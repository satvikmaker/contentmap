<script setup lang="ts">
import { posts } from 'contentmap/generated'

// Reads the index only. Bodies live in per-document modules this never imports.
const cards = posts.select('title', 'slug').sortBy('date', 'desc').all()
</script>

<template>
  <main>
    <h1>Posts</h1>
    <ul>
      <li v-for="post in cards" :key="post.slug" :data-slug="post.slug">{{ post.title }}</li>
    </ul>
  </main>
</template>

<script setup lang="ts">
/**
 * Placeholder rows for a table that is still loading.
 *
 * A skeleton rather than a spinner because the shape is known: the table already has its columns, so
 * standing in for the rows keeps the header, the widths and the page height put. A spinner in the
 * same place collapses the table to nothing and then shoves the page down when the data lands.
 *
 * It never renders an empty state. That is the caller's job, and the distinction matters — "nothing
 * here" and "nothing here yet" look identical to a reader and mean opposite things.
 */
withDefaults(defineProps<{ rows?: number; columns?: number }>(), { rows: 4, columns: 4 })
</script>

<template>
  <tbody>
    <tr v-for="row in rows" :key="row">
      <td v-for="column in columns" :key="column">
        <!--
          Widths alternate so the block reads as text rather than as a bar chart. The first column is
          wider because in every table here it holds a name.
        -->
        <div class="skeleton h-4" :class="column === 1 ? 'w-40' : column % 2 ? 'w-16' : 'w-24'"></div>
      </td>
    </tr>
  </tbody>
</template>

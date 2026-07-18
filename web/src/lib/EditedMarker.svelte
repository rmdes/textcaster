<script lang="ts">
	let { post }: { post: { id: string; editedAt?: string | null } } = $props()
</script>

{#if post.editedAt}
	<a class="edited" href="/post/{post.id}/history" title={post.editedAt}>edited</a>
{/if}

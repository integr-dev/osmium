package net.integr.osmium.avatar.controller

import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.responses.ApiResponse
import io.swagger.v3.oas.annotations.responses.ApiResponses
import io.swagger.v3.oas.annotations.tags.Tag
import net.integr.osmium.avatar.config.AvatarProperties
import net.integr.osmium.avatar.service.AvatarService
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.concurrent.TimeUnit

@RestController
@RequestMapping("/api/avatars")
@Tag(name = "Avatars", description = "Minecraft player heads, proxied so the browser stays same-origin.")
class AvatarController(
    private val avatarService: AvatarService,
    private val properties: AvatarProperties,
) {

    /**
     * Gated like every other route, on the node the caller must already hold to be looking at a
     * head at all: agents, chat and hosts are all `agent.read`, and a head only ever appears beside
     * one of them.
     *
     * That costs the frontend the obvious implementation. An `<img>` cannot send an `Authorization`
     * header, and the access token is not a cookie — the only cookie in this app is the refresh
     * token, scoped to `/api/auth` — so the SPA fetches each head itself and hands the `<img>` a
     * blob; see `src/lib/avatars.ts`. The alternative was leaving this endpoint open on the grounds
     * that a public Minecraft skin is not a secret, which is true and still makes the fleet's
     * outbound requests answerable to nobody.
     */
    // No `produces`: the content type is whatever the skin service sent, and pinning it to PNG here
    // would turn a JPEG upstream into a 406 rather than into a head.
    @GetMapping("/{identifier}")
    @PreAuthorize("hasAuthority('agent.read')")
    @Operation(
        summary = "A player's head.",
        description = "Accepts a Minecraft username or UUID. Fetched from a skin service and " +
            "cached, so no operator's browser talks to it directly.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The head, as an image."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.read`."),
        ApiResponse(
            responseCode = "404",
            description = "No head: unknown player, malformed identifier, upstream unavailable, or " +
                "avatars disabled. The caller renders its own fallback either way.",
        ),
    )
    fun head(@PathVariable identifier: String): ResponseEntity<ByteArray> = served(avatarService.head(identifier))

    /**
     * The whole skin, for the 3D view, which wraps it around a player model.
     *
     * A different image of the same player rather than a larger head: what `/{identifier}` returns
     * is a crop with the hat layer composited on, which is exactly right at 32 pixels beside a name
     * and unusable as a texture. Its own upstream and its own switch — see [AvatarProperties].
     */
    @GetMapping("/{identifier}/skin")
    @PreAuthorize("hasAuthority('agent.view')")
    @Operation(
        summary = "A player's whole skin.",
        description = "The 64x64 sheet, for texturing a model. Accepts a username or UUID. " +
            "Fetched from a skin service and cached, like the head.",
    )
    @ApiResponses(
        ApiResponse(responseCode = "200", description = "The skin, as an image."),
        ApiResponse(responseCode = "403", description = "Missing node `agent.view`."),
        ApiResponse(
            responseCode = "404",
            description = "No skin: unknown player, malformed identifier, upstream unavailable, or " +
                "skins disabled. The viewer falls back to the default model texture.",
        ),
    )
    fun skin(@PathVariable identifier: String): ResponseEntity<ByteArray> = served(avatarService.skin(identifier))

    /**
     * Cached by the browser for the same span the backend holds it, so a page that renders one
     * player thirty times makes one request rather than thirty.
     */
    private fun served(avatar: net.integr.osmium.avatar.service.Avatar?): ResponseEntity<ByteArray> {
        if (avatar == null) return ResponseEntity.notFound().build()

        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(avatar.contentType))
            .cacheControl(CacheControl.maxAge(properties.ttl.seconds, TimeUnit.SECONDS).cachePublic())
            .body(avatar.bytes)
    }
}

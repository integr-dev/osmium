package net.integr.osmium.controller

import net.integr.osmium.dto.ApiError
import net.integr.osmium.service.HostUnreachableException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

/**
 * Maps the exception types the services throw onto status codes. Authorization failures are
 * deliberately absent: `AccessDeniedException` must reach Spring Security's own translation filter
 * so it still produces a 403.
 */
@RestControllerAdvice
class ApiExceptionHandler {

    @ExceptionHandler(BadCredentialsException::class)
    fun onBadCredentials(exception: BadCredentialsException): ResponseEntity<ApiError> =
        error(status = HttpStatus.UNAUTHORIZED, message = exception.message)

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun onInvalidBody(exception: MethodArgumentNotValidException): ResponseEntity<ApiError> {
        val message = exception.bindingResult.fieldErrors
            .sortedBy { it.field }
            .joinToString { "${it.field}: ${it.defaultMessage}" }

        return error(status = HttpStatus.BAD_REQUEST, message = message.ifBlank { null })
    }

    @ExceptionHandler(NoSuchElementException::class)
    fun onNotFound(exception: NoSuchElementException): ResponseEntity<ApiError> =
        error(status = HttpStatus.NOT_FOUND, message = exception.message)

    @ExceptionHandler(IllegalArgumentException::class)
    fun onInvalidRequest(exception: IllegalArgumentException): ResponseEntity<ApiError> =
        error(status = HttpStatus.BAD_REQUEST, message = exception.message)

    @ExceptionHandler(IllegalStateException::class)
    fun onConflict(exception: IllegalStateException): ResponseEntity<ApiError> =
        error(status = HttpStatus.CONFLICT, message = exception.message)

    /** Distinct from 409: the request was valid, but there is nothing live to deliver it to. */
    @ExceptionHandler(HostUnreachableException::class)
    fun onHostUnreachable(exception: HostUnreachableException): ResponseEntity<ApiError> =
        error(status = HttpStatus.SERVICE_UNAVAILABLE, message = exception.message)

    private fun error(status: HttpStatus, message: String?): ResponseEntity<ApiError> =
        ResponseEntity.status(status).body(ApiError(message = message ?: status.reasonPhrase))
}

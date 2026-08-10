package net.integr.osmium.account.service

import net.integr.osmium.account.dto.RoleResponse
import net.integr.osmium.account.dto.toResponse
import net.integr.osmium.account.repository.RoleRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
@Transactional(readOnly = true)
class RoleService(private val roleRepository: RoleRepository) {

    fun findAll(): List<RoleResponse> =
        roleRepository.findAll().sortedBy { it.name }.map { it.toResponse() }
}

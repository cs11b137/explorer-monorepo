	.intel_syntax noprefix
	.file	"sum.c"
	.text
	.globl	sum                             # -- Begin function sum
	.p2align	4
	.type	sum,@function
sum:                                    # @sum
# %bb.0:
	push	rbx
	mov	ebx, edi
	test	edi, edi
	jle	.LBB0_1
# %bb.2:
	lea	eax, [rbx + rbx]
	lea	ecx, [rax + 2*rax]
	lea	edx, [rbx - 1]
	lea	eax, [rax + 2*rax]
	inc	eax
	imul	eax, edx
	add	eax, ecx
	lea	edi, [rbx - 2]
	imul	rdi, rdx
	shr	rdi
	add	edi, eax
	jmp	.LBB0_3
.LBB0_1:
	xor	edi, edi
.LBB0_3:
	mov	dword ptr [rip + total], edi
                                        # kill: def $edi killed $edi killed $rdi
	call	scale@PLT
	add	eax, ebx
	pop	rbx
	ret
.Lfunc_end0:
	.size	sum, .Lfunc_end0-sum
                                        # -- End function
	.type	total,@object                   # @total
	.bss
	.globl	total
	.p2align	2, 0x0
total:
	.long	0                               # 0x0
	.size	total, 4

	.ident	"Apple clang version 21.0.0 (clang-2100.4.1.1)"
	.section	".note.GNU-stack","",@progbits
	.addrsig
